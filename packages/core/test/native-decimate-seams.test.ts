/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * QEM decimation on an atlased mesh (processing::QuadricDecimator, lod::simplifyForLod, the Nanite DAG), on a real
 * closed, bumped torus whose UVs are cut into 4 x 4-quad charts (a seam at most vertices, as a photogrammetry atlas):
 * - crossSeams reaches a 10% target, stays closed, and keeps the input surface close (largest distance measured from
 *   input vertices to the result; measured 0.136 m against the 0.25 m bump);
 * - the LOD pyramid reaches every level's count, stays closed (no seam cracks) and far nearer the surface than the
 *   halfedge::decimateMeshQEM it replaced at the same count (measured 0.077 m and 0 open edges against 0.80 m and
 *   3,786 open edges at a quarter);
 * - most Nanite parents hold about half their two children's triangles;
 * - optimizeVertexCache takes a shuffled mesh's ACMR from about 3 to under 0.8; the decimator's output sits at the
 *   ACMR floor (vertices / triangles) and optimizeVertexFetch drops no vertex a triangle uses; the LOD GLB has glTF magic.
 * On the raw tile and Pipeline K benchmarks (not in tests) seams respected stall the collapse; crossSeams is what
 * lets an atlased scan go below about half.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

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

const PROGRAM = String.raw`
#include "scratchbox_engine.hpp"
#include <cstdio>
#include <map>
#include <random>
namespace sb = scratchbox;
using sb::geometry::ScratchboxMesh; using sb::geometry::Vertex; using sb::math::Vec3; using sb::math::Vec2;

// torus R=10 m, r=3 m, bumped 0.25 m; each 4 x 4-quad block is its own UV chart (own vertices on its border)
static ScratchboxMesh atlasTorus(int nu, int nv) {
    ScratchboxMesh m("torus");
    auto pos = [&](int i, int j) {
        double u = 2 * M_PI * (i % nu) / nu, v = 2 * M_PI * (j % nv) / nv;
        double rr = 3.0 + 0.25 * std::sin(5 * u) * std::sin(7 * v);
        Vec3 n(float(std::cos(u) * std::cos(v)), float(std::sin(v)), float(std::sin(u) * std::cos(v)));
        return std::make_pair(Vec3(float(10 * std::cos(u)), 0.f, float(10 * std::sin(u))) + n * float(rr), n);
    };
    const int C = 4;
    for (int ci = 0; ci < nu; ci += C) for (int cj = 0; cj < nv; cj += C) {
        uint32_t base = uint32_t(m.vertices.size());
        // each chart sits at its own place in the atlas
        Vec2 origin(float((ci / C) % 16) / 16.f, float((cj / C) % 16) / 16.f);
        for (int a = 0; a <= C; ++a) for (int b = 0; b <= C; ++b) {
            auto [p, n] = pos(ci + a, cj + b);
            m.addVertex(Vertex(p, n, Vec2(origin.x + a / 80.f, origin.y + b / 80.f)));
        }
        for (int a = 0; a < C; ++a) for (int b = 0; b < C; ++b) {
            uint32_t p00 = base + a * (C + 1) + b, p10 = p00 + (C + 1);
            m.addTriangle(p00, p00 + 1, p10); m.addTriangle(p10, p00 + 1, p10 + 1);
        }
    }
    return m;
}
static double ptTri(Vec3 p, Vec3 a, Vec3 b, Vec3 c) {
    Vec3 ab = b - a, ac = c - a, ap = p - a;
    double d1 = ab.dot(ap), d2 = ac.dot(ap); if (d1 <= 0 && d2 <= 0) return (p - a).length();
    Vec3 bp = p - b; double d3 = ab.dot(bp), d4 = ac.dot(bp); if (d3 >= 0 && d4 <= d3) return (p - b).length();
    double vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) return (p - (a + ab * float(d1 / (d1 - d3)))).length();
    Vec3 cp = p - c; double d5 = ab.dot(cp), d6 = ac.dot(cp); if (d6 >= 0 && d5 <= d6) return (p - c).length();
    double vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) return (p - (a + ac * float(d2 / (d2 - d6)))).length();
    double va = d3 * d6 - d5 * d4; if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return (p - (b + (c - b) * float((d4 - d3) / ((d4 - d3) + (d5 - d6))))).length();
    double den = 1.0 / (va + vb + vc); return (p - (a + ab * float(vb * den) + ac * float(vc * den))).length();
}
static double deviation(const ScratchboxMesh& in, const ScratchboxMesh& out) {
    double worst = 0;
    for (size_t k = 0; k < in.vertices.size(); k += 5) {
        double best = 1e30;
        for (size_t t = 0; t + 2 < out.indices.size(); t += 3)
            best = std::min(best, ptTri(in.vertices[k].position, out.vertices[out.indices[t]].position, out.vertices[out.indices[t + 1]].position, out.vertices[out.indices[t + 2]].position));
        worst = std::max(worst, best);
    }
    return worst;
}
static size_t openEdges(const ScratchboxMesh& m) {
    std::map<std::tuple<long, long, long>, uint32_t> id; std::vector<uint32_t> w(m.vertices.size());
    for (size_t i = 0; i < m.vertices.size(); ++i) { auto& p = m.vertices[i].position; w[i] = id.emplace(std::make_tuple(std::lround(p.x * 1e4), std::lround(p.y * 1e4), std::lround(p.z * 1e4)), uint32_t(id.size())).first->second; }
    std::map<std::pair<uint32_t, uint32_t>, int> e;
    for (size_t t = 0; t + 2 < m.indices.size(); t += 3) for (int k = 0; k < 3; ++k) {
        uint32_t a = w[m.indices[t + k]], b = w[m.indices[t + (k + 1) % 3]]; if (a == b) continue; e[{std::min(a, b), std::max(a, b)}]++;
    }
    size_t n = 0; for (auto& [k, c] : e) if (c == 1) ++n; return n;
}
int main(int, char** argv) {
    ScratchboxMesh in = atlasTorus(128, 64);
    const size_t T = in.indices.size() / 3, target = T / 10;
    sb::processing::DecimateOptions locked; locked.targetTriangles = target;
    ScratchboxMesh a = sb::processing::QuadricDecimator::decimate(in, locked);
    sb::processing::DecimateOptions crossing = locked; crossing.crossSeams = true;
    ScratchboxMesh b = sb::processing::QuadricDecimator::decimate(in, crossing);
    ScratchboxMesh oldLod = sb::halfedge::decimateMeshQEM(in, uint32_t(T / 4));
    auto pyr = sb::lod::buildLodPyramid(in);
    std::printf("{\"in\":%zu,\"inOpen\":%zu,\"target\":%zu,\"lockedTris\":%zu,\"crossTris\":%zu,\"crossOpen\":%zu,\"crossDev\":%.5f,",
        T, openEdges(in), target, a.indices.size() / 3, b.indices.size() / 3, openEdges(b), deviation(in, b));
    std::printf("\"lod\":[");
    for (size_t i = 0; i < pyr.size(); ++i) std::printf("%s{\"tris\":%zu,\"open\":%zu,\"dev\":%.5f}", i ? "," : "", pyr.levels[i].mesh.indices.size() / 3, openEdges(pyr.levels[i].mesh), i ? deviation(in, pyr.levels[i].mesh) : 0.0);
    std::printf("],\"oldQuarterTris\":%zu,\"oldQuarterOpen\":%zu,\"oldQuarterDev\":%.5f,", oldLod.indices.size() / 3, openEdges(oldLod), deviation(in, oldLod));

    sb::nanite::NaniteClusterDAG dag; dag.buildFromMesh(in, 128);
    size_t parents = 0, halved = 0;
    for (const auto& c : dag.clusters) {
        if (c.lodLevel == 0 || c.childClusterIds.empty()) continue;
        ++parents;
        size_t childTris = 0;
        for (uint32_t id : c.childClusterIds) childTris += dag.clusters[id].indices.size() / 3;
        if (c.indices.size() / 3 <= childTris * 0.55) ++halved;
    }
    std::printf("\"naniteParents\":%zu,\"naniteHalved\":%zu,", parents, halved);

    // vertex cache
    ScratchboxMesh shuffled = in;
    std::vector<std::array<uint32_t, 3>> tris; for (size_t t = 0; t < in.indices.size(); t += 3) tris.push_back({in.indices[t], in.indices[t + 1], in.indices[t + 2]});
    std::mt19937 rng(7); std::shuffle(tris.begin(), tris.end(), rng);
    shuffled.indices.clear(); for (auto& t : tris) shuffled.addTriangle(t[0], t[1], t[2]);
    const double acmrShuffled = sb::processing::vertexCacheMissRatio(shuffled.indices, shuffled.vertices.size());
    sb::processing::optimizeVertexCache(shuffled.indices, shuffled.vertices.size());
    const double acmrOrdered = sb::processing::vertexCacheMissRatio(shuffled.indices, shuffled.vertices.size());
    const size_t vertsBefore = shuffled.vertices.size();
    sb::processing::optimizeVertexFetch(shuffled);
    sb::processing::DecimateOptions unordered = crossing; unordered.optimizeOrder = false;
    ScratchboxMesh c = sb::processing::QuadricDecimator::decimate(in, unordered);
    std::printf("\"acmrShuffled\":%.4f,\"acmrOrdered\":%.4f,\"fetchVertsBefore\":%zu,\"fetchVertsAfter\":%zu,\"decimAcmr\":%.4f,\"decimAcmrUnordered\":%.4f,\"decimFloor\":%.4f}\n",
        acmrShuffled, acmrOrdered, vertsBefore, shuffled.vertices.size(),
        sb::processing::vertexCacheMissRatio(b.indices, b.vertices.size()), sb::processing::vertexCacheMissRatio(c.indices, c.vertices.size()), double(b.vertices.size()) / double(b.indices.size() / 3));

    std::vector<ScratchboxMesh> lods = { pyr.levels[0].mesh, pyr.levels[1].mesh };
    auto glb = sb::io::GlbWriter::serializeLodGlb(lods);
    FILE* f = std::fopen(argv[1], "wb"); std::fwrite(glb.data(), 1, glb.size(), f); std::fclose(f);
    return 0;
}
`;

describe('QEM decimation on an atlased mesh', () => {
    it('crosses seams to its target, keeps LODs closed and near the surface, and orders for the vertex cache', async () => {
        const compiler = new NativeCppCompilerService();
        const outDir = path.join(dir, 'run');
        const res = await compiler.compileSource(PROGRAM, { outputDir: outDir, outputBinaryName: 'decimate_seams' });
        expect(res.compilerOutput).not.toMatch(/error:/);
        expect(res.success).toBe(true);
        const glbPath = path.join(outDir, 'lod.glb');
        const run = await compiler.executeBinary(res.binaryPath!, [glbPath], outDir);
        expect(run.exitCode).toBe(0);
        const m = JSON.parse(run.stdout.trim().split('\n').pop()!);

        expect(m.in).toBe(128 * 64 * 2);
        expect(m.inOpen).toBe(0);
        // seams crossed: the target reached, still closed, the input surface within 0.25 m (the bump's amplitude)
        expect(m.crossTris).toBeLessThanOrEqual(m.target);
        expect(m.crossTris).toBeGreaterThan(m.target * 0.9);
        expect(m.crossOpen).toBe(0);
        expect(m.crossDev).toBeLessThan(0.25);

        // the LOD pyramid: every level at its share, closed, and nearer the surface than the old QEM at a quarter
        const ratios = [1, 0.5, 0.25, 0.125];
        m.lod.forEach((l: { tris: number; open: number; dev: number }, i: number) => {
            expect(l.tris).toBeLessThanOrEqual(Math.max(4, Math.floor(m.in * ratios[i])));
            expect(l.tris).toBeGreaterThan(m.in * ratios[i] * 0.9);
            expect(l.open).toBe(0);
        });
        expect(m.lod[2].dev).toBeLessThan(m.oldQuarterDev);

        // Nanite: most parents hold at most 55% of their two children's triangles (116 of 127 here; small merged groups
        // with pinned borders stop short)
        expect(m.naniteParents).toBeGreaterThan(50);
        expect(m.naniteHalved).toBeGreaterThanOrEqual(m.naniteParents * 0.85);

        // vertex cache and fetch
        expect(m.acmrShuffled).toBeGreaterThan(2);
        expect(m.acmrOrdered).toBeLessThan(0.8);
        expect(m.fetchVertsAfter).toBe(m.fetchVertsBefore);
        expect(m.decimAcmr).toBeLessThanOrEqual(m.decimAcmrUnordered + 1e-9);
        expect(m.decimAcmr).toBeLessThan(m.decimFloor * 1.05);

        const glb = fs.readFileSync(glbPath);
        expect(glb.subarray(0, 4).toString('latin1')).toBe('glTF');
        expect(glb.readUInt32LE(8)).toBe(glb.length);
    });
});
