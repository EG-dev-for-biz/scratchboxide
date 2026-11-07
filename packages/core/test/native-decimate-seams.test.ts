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
 *   1.8); the Nanite DAG's roots keep the building (hundreds of triangles or more, not ~125); the LOD GLB has glTF magic.
 *   Measured before/after on real buildings in the PR (the old QEM: 44-201 cm RMS from half to an eighth on twins).
 * - Formula unit test (synthetic on purpose): optimizeVertexCache takes a shuffled grid's ACMR from about 3 to under
 *   0.8 and optimizeVertexFetch keeps every used vertex.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { withReason, type Requirement } from './helpers/requirements';

function realFile(env: string, what: string): { path?: string; req: Requirement } {
    const p = process.env[env];
    if (p && fs.existsSync(p)) return { path: p, req: { ok: true, reason: '' } };
    return { req: { ok: false, reason: `set ${env} to ${what} (gitignored real data from a staged-location run)` } };
}
const twin = realFile('SCRATCHBOX_DECIMATE_REAL_GLB', 'a cached Pipeline K twin.glb');

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

const REAL_PROGRAM = COMMON + String.raw`
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
int main(int, char** argv) {
    ScratchboxMesh in = sb::io::GlbReader::readGlb(argv[1]);
    { std::vector<uint32_t> keep; for (size_t t = 0; t + 2 < in.indices.size(); t += 3) { uint32_t a = in.indices[t], b = in.indices[t + 1], c = in.indices[t + 2]; if (a != b && b != c && a != c) keep.insert(keep.end(), {a, b, c}); } in.indices = keep; sb::processing::optimizeVertexFetch(in); }
    const auto s = samples(in, 100000);
    auto pyr = sb::lod::buildLodPyramid(in);
    std::printf("{\"in\":%zu,\"inOpen\":%zu,\"lod\":[", in.indices.size() / 3, openEdges(in));
    for (size_t i = 1; i < pyr.size(); ++i) { const auto& m = pyr.levels[i].mesh;
        std::printf("%s{\"tris\":%zu,\"open\":%zu,\"rms\":%.5f,\"acmr\":%.4f,\"ratio\":%.5f}", i > 1 ? "," : "", m.indices.size() / 3, openEdges(m), rms(s, m), sb::processing::vertexCacheMissRatio(m.indices, m.vertices.size()), pyr.levels[i].triangleRatio); }
    sb::nanite::NaniteClusterDAG dag; dag.buildFromMesh(in, 128);
    size_t rootTris = 0; for (uint32_t id : dag.rootClusterIds) rootTris += dag.clusters[id].indices.size() / 3;
    std::printf("],\"naniteRootTris\":%zu}\n", rootTris);
    std::vector<ScratchboxMesh> lods = { pyr.levels[0].mesh, pyr.levels[1].mesh };
    auto glb = sb::io::GlbWriter::serializeLodGlb(lods);
    FILE* f = std::fopen(argv[2], "wb"); std::fwrite(glb.data(), 1, glb.size(), f); std::fclose(f);
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

async function runProgram(source: string, name: string, args: string[] = []): Promise<any> {
    const compiler = new NativeCppCompilerService();
    const outDir = path.join(dir, name);
    const res = await compiler.compileSource(source, { outputDir: outDir, outputBinaryName: name });
    expect(res.compilerOutput).not.toMatch(/error:/);
    expect(res.success).toBe(true);
    const run = await compiler.executeBinary(res.binaryPath!, args, outDir);
    expect(run.exitCode).toBe(0);
    return JSON.parse(run.stdout.trim().split('\n').pop()!);
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
        expect(m.naniteRootTris).toBeGreaterThan(500);
        const glb = fs.readFileSync(glbPath);
        expect(glb.subarray(0, 4).toString('latin1')).toBe('glTF');
        expect(glb.readUInt32LE(8)).toBe(glb.length);
    });

    it('orders triangles for the vertex cache and vertices for fetch (formula check)', async () => {
        const m = await runProgram(FORMULA_PROGRAM, 'vertex_cache');
        expect(m.tris).toBe(96 * 96 * 2);
        expect(m.before).toBeGreaterThan(2);
        expect(m.after).toBeLessThan(0.8);
        expect(m.vertsAfter).toBe(m.verts);
    });
});
