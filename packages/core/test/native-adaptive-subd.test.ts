import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { compileNativeCached, defaultNativeFlags } from '../src/node/3d-engine/native-build-cache';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

// scratchbox_adaptive_subd.hpp on real geometry: every check below reads the tessellated, displaced mesh itself.
const SOURCE = String.raw`
#include "scratchbox_adaptive_subd.hpp"
#include "scratchbox_displacement.hpp"
#include <cstdio>
#include <map>
#include <tuple>
using namespace scratchbox;
using math::Vec2; using math::Vec3;

// A 2 m cube with a vertex per face corner (24 vertices): UV seams and hard normals on every edge.
static geometry::ScratchboxMesh cube() {
    geometry::ScratchboxMesh m("cube");
    const Vec3 n[6] = {{1,0,0},{-1,0,0},{0,1,0},{0,-1,0},{0,0,1},{0,0,-1}};
    for (int f = 0; f < 6; f++) {
        const Vec3 N = n[f];
        const Vec3 U = std::fabs(N.y) > 0.5f ? Vec3(1,0,0) : Vec3(0,1,0);
        const Vec3 A = U.cross(N), B = N.cross(A);
        const uint32_t base = uint32_t(m.vertices.size());
        const float s[4][2] = {{-1,-1},{1,-1},{1,1},{-1,1}};
        for (int k = 0; k < 4; k++) m.vertices.push_back(geometry::Vertex(N + A * s[k][0] + B * s[k][1], N, Vec2(0.5f + 0.5f * s[k][0] + f, 0.5f + 0.5f * s[k][1])));
        m.indices.insert(m.indices.end(), {base, base + 1, base + 2, base, base + 2, base + 3});
    }
    return m;
}

// Edges (by welded position) not shared by exactly two triangles: 0 for a closed, crack-free surface.
static size_t openEdges(const geometry::ScratchboxMesh& m, bool (*onOutline)(const Vec3&) = nullptr) {
    std::map<std::tuple<long,long,long>, uint32_t> weld; std::vector<uint32_t> id(m.vertices.size());
    for (size_t i = 0; i < m.vertices.size(); i++) { const Vec3& p = m.vertices[i].position;
        auto k = std::make_tuple(std::lround(p.x * 1e5), std::lround(p.y * 1e5), std::lround(p.z * 1e5));
        id[i] = weld.emplace(k, uint32_t(weld.size())).first->second; }
    std::map<std::pair<uint32_t,uint32_t>, std::pair<int, Vec3>> uses;
    for (size_t t = 0; t < m.indices.size(); t += 3) for (int k = 0; k < 3; k++) {
        const uint32_t ia = m.indices[t + k], ib = m.indices[t + (k + 1) % 3];
        uint32_t a = id[ia], b = id[ib]; if (a > b) std::swap(a, b);
        auto& e = uses[{a, b}]; e.first++; e.second = (m.vertices[ia].position + m.vertices[ib].position) * 0.5f; }
    size_t open = 0; for (auto& [e, c] : uses) if (c.first != 2 && !(onOutline && onOutline(c.second))) open++;
    return open;
}

static geometry::ScratchboxMesh strip(float len, float cell) {
    geometry::ScratchboxMesh m("strip");
    const int nz = int(len / cell);
    for (int j = 0; j <= 1; j++) for (int i = 0; i <= nz; i++) m.vertices.push_back(geometry::Vertex(Vec3(j * cell, 0, -i * cell), Vec3(0,1,0), Vec2(j, float(i))));
    for (int i = 0; i < nz; i++) { uint32_t a = i, b = i + 1, c = a + nz + 1, d = c + 1; m.indices.insert(m.indices.end(), {a, c, b, b, c, d}); }
    return m;
}

int main() {
    auto bumps = [](const Vec2& uv, const Vec3&, const Vec3&, uint32_t) { return 0.05f * std::sin(uv.x * 9.0f) * std::sin(uv.y * 7.0f) + 0.03f; };

    // 1. a closed cube with seams on every edge stays closed when displaced; the even tessellation tears
    const auto box = cube();
    adaptive_subd::Params wp; wp.dicingRate = 0.1f;
    const auto a = adaptive_subd::diceAndDisplace(box, wp, bumps);
    displacement::DisplacementOptions uo; uo.tessellationFactor = 20; uo.sampleTextureHeight = false; uo.enableProceduralNoise = true; uo.proceduralNoiseScale = 0.05f;
    const auto u = displacement::DisplacementEngine::tessellateAndDisplaceMesh(box, uo, nullptr);

    // 2. world mode: no edge longer than the rate allows (sqrt 2 for an inner diagonal), none degenerate
    float maxEdge = 0, minEdge = 1e9f;
    const auto flat = adaptive_subd::diceAndDisplace(box, wp, nullptr);
    for (size_t t = 0; t < flat.mesh.indices.size(); t += 3) for (int k = 0; k < 3; k++) {
        const float l = (flat.mesh.vertices[flat.mesh.indices[t + k]].position - flat.mesh.vertices[flat.mesh.indices[t + (k + 1) % 3]].position).length();
        maxEdge = std::max(maxEdge, l); minEdge = std::min(minEdge, l); }
    // orientation and flatness kept: every output triangle faces like its input face, and stays on the cube
    size_t flipped = 0; float offCube = 0;
    for (size_t t = 0; t < flat.mesh.indices.size() / 3; t++) {
        const auto& v0 = flat.mesh.vertices[flat.mesh.indices[t * 3]].position, &v1 = flat.mesh.vertices[flat.mesh.indices[t * 3 + 1]].position, &v2 = flat.mesh.vertices[flat.mesh.indices[t * 3 + 2]].position;
        const uint32_t src = flat.triangleSource[t];
        if ((v1 - v0).cross(v2 - v0).dot(box.vertices[box.indices[src * 3]].normal) <= 0) flipped++;
        for (const Vec3* p : {&v0, &v1, &v2}) offCube = std::max(offCube, std::fabs(std::max({std::fabs(p->x), std::fabs(p->y), std::fabs(p->z)}) - 1.0f));
    }

    // 3. a constant height moves a plane by exactly that height
    auto plane = strip(10.0f, 1.0f);
    const auto lifted = adaptive_subd::diceAndDisplace(plane, wp, [](const Vec2&, const Vec3&, const Vec3&, uint32_t) { return 0.1f; });
    float liftErr = 0; for (const auto& v : lifted.mesh.vertices) liftErr = std::max(liftErr, std::fabs(v.position.y - 0.1f));

    // 4. camera mode: a strip running away from the camera is diced finely near it and coarsely far away, about
    //    dicingRate pixels a segment on screen
    adaptive_subd::Params cp; cp.useCamera = true; cp.dicingRate = 4.0f;
    cp.camera.position = Vec3(0.5f, 1.5f, 1.0f); cp.camera.target = Vec3(0.5f, 0.0f, -10.0f); cp.camera.width = 1280; cp.camera.height = 720; cp.camera.fovYRadians = 1.0f;
    auto road = strip(100.0f, 1.0f);
    const auto c = adaptive_subd::diceAndDisplace(road, cp, nullptr);
    double nearSum = 0, farSum = 0; size_t nearN = 0, farN = 0; std::vector<float> pxEdges;
    const float pixelAngle = 2.0f * std::tan(0.5f) / 720.0f;
    for (size_t t = 0; t < c.mesh.indices.size(); t += 3) for (int k = 0; k < 3; k++) {
        const Vec3 p = c.mesh.vertices[c.mesh.indices[t + k]].position, q = c.mesh.vertices[c.mesh.indices[t + (k + 1) % 3]].position;
        const float l = (p - q).length(); const float dist = (((p + q) * 0.5f) - cp.camera.position).length();
        if (dist < 5) { nearSum += l; nearN++; } else if (dist > 50) { farSum += l; farN++; }
        if (dist > 2 && dist < 40) pxEdges.push_back(l / (dist * pixelAngle));
    }
    std::sort(pxEdges.begin(), pxEdges.end());
    // 5. input vertices no triangle uses are ignored (a mesh cut down to some of its triangles keeps all its vertices)
    auto partial = road; partial.indices.resize(30 * 3);
    const auto pr = adaptive_subd::diceAndDisplace(partial, wp, bumps);
    size_t partialBad = 0; for (const auto& v : pr.mesh.vertices) if (!std::isfinite(v.position.x) || v.position.z < -15.5f) partialBad++;
    // 6. the tile path tracer's entry point: a scene diced for its camera keeps each triangle's material and stays closed
    gltf::GltfScene sc; sc.ok = true; sc.mesh = box; sc.materials.resize(2);
    for (size_t t = 0; t < box.indices.size() / 3; t++) sc.triangleMaterial.push_back(uint32_t((t / 2) % 2));
    displacement::DisplacementOptions so; so.sampleTextureHeight = false; so.enableProceduralNoise = true; so.proceduralNoiseScale = 0.04f;
    adaptive_subd::CameraSpec view; view.position = Vec3(4, 3, 5); view.target = Vec3(0, 0, 0); view.width = 640; view.height = 360;
    const auto ds = displacement::DisplacementEngine::displaceSceneForView(sc, so, view, 4.0f);
    size_t matWrong = 0; const auto dsr = adaptive_subd::diceAndDisplace(box, [&]{ adaptive_subd::Params q; q.useCamera = true; q.camera = view; q.dicingRate = 4.0f; return q; }(), nullptr);
    for (size_t t = 0; t < ds.triangleMaterial.size() && t < dsr.triangleSource.size(); t++) if (ds.triangleMaterial[t] != uint32_t((dsr.triangleSource[t] / 2) % 2)) matWrong++;
    const auto refused = displacement::DisplacementEngine::displaceSceneForView(sc, so, view, 4.0f, 50);
    adaptive_subd::Params lim = cp; lim.maxTriangles = 100;
    const auto limited = adaptive_subd::diceAndDisplace(road, lim, nullptr);

    std::printf("{\"cubeAdaptiveTris\":%zu,\"cubeAdaptiveOpen\":%zu,\"cubeUniformOpen\":%zu,\"maxEdge\":%.4f,\"minEdge\":%.6f,\"flipped\":%zu,\"offCube\":%.6f,"
                "\"liftErr\":%.6f,\"liftTris\":%zu,\"roadTris\":%zu,\"nearMeanEdge\":%.4f,\"farMeanEdge\":%.4f,\"pxEdgeP50\":%.3f,\"pxEdgeP95\":%.3f,\"roadOpen\":%zu,"
                "\"sceneOk\":%d,\"sceneTris\":%zu,\"sceneMatSize\":%zu,\"sceneMatWrong\":%zu,\"sceneOpen\":%zu,\"sceneRefused\":%d,\"partialOk\":%d,\"partialTris\":%zu,\"partialBad\":%zu,\"limitedOk\":%d,\"limitedError\":\"%s\",\"cubeHeightMin\":%.4f}\n",
        a.stats.triangles, openEdges(a.mesh), openEdges(u), maxEdge, minEdge, flipped, offCube, liftErr, lifted.stats.triangles, c.stats.triangles,
        nearSum / std::max<size_t>(1, nearN), farSum / std::max<size_t>(1, farN), pxEdges[pxEdges.size() / 2], pxEdges[size_t(pxEdges.size() * 0.95)], openEdges(c.mesh, [](const Vec3& p) { return std::fabs(p.x) < 1e-4f || std::fabs(p.x - 1.0f) < 1e-4f || std::fabs(p.z) < 1e-4f || std::fabs(p.z + 100.0f) < 1e-4f; }),
        ds.ok ? 1 : 0, ds.mesh.indices.size() / 3, ds.triangleMaterial.size(), matWrong, openEdges(ds.mesh), refused.ok ? 0 : 1, pr.ok ? 1 : 0, pr.stats.triangles, partialBad, limited.ok ? 1 : 0, limited.error.c_str(), [&]{ float m = 1e9f; for (auto& v : a.mesh.vertices) m = std::min(m, std::max({std::fabs(v.position.x), std::fabs(v.position.y), std::fabs(v.position.z)})); return m; }());
    return 0;
}
`;

interface Out {
    cubeAdaptiveTris: number; cubeAdaptiveOpen: number; cubeUniformOpen: number; maxEdge: number; minEdge: number; flipped: number; offCube: number;
    liftErr: number; liftTris: number; roadTris: number; nearMeanEdge: number; farMeanEdge: number; pxEdgeP50: number; pxEdgeP95: number; roadOpen: number;
    sceneOk: number; sceneTris: number; sceneMatSize: number; sceneMatWrong: number; sceneOpen: number; sceneRefused: number; partialOk: number; partialTris: number; partialBad: number; limitedOk: number; limitedError: string; cubeHeightMin: number;
}

let out: Out;

describe('adaptive subdivision and displacement (scratchbox_adaptive_subd.hpp)', () => {
    beforeAll(async () => {
        const compiler = NativeCppCompilerService.getInstance();
        const built = await compileNativeCached({ sourceCode: SOURCE, includeDirs: [compiler.getSdkIncludePath()], flags: defaultNativeFlags(), libs: ['-lz'], name: 'adaptive_subd_test' });
        const stdout = await new Promise<string>((resolve, reject) =>
            execFile(built.binaryPath, [], { timeout: 120_000, maxBuffer: 1 << 20 }, (err, so, se) => (err ? reject(Object.assign(err, { stderr: se })) : resolve(so))));
        out = JSON.parse(stdout.trim()) as Out;
    }, 600_000);

    it('keeps a closed cube closed when displaced across UV and normal seams, where the even tessellation tears', () => {
        expect(out.cubeAdaptiveTris).toBeGreaterThan(1000);
        expect(out.cubeAdaptiveOpen).toBe(0);
        expect(out.cubeUniformOpen).toBeGreaterThan(0);
        // the height (0.03 +- 0.05 m) moved the surface: some vertices went inward
        expect(out.cubeHeightMin).toBeLessThan(0.99);
    });

    it('in world mode keeps every edge within the rate, faces as its input face and stays on the input surface', () => {
        expect(out.maxEdge).toBeLessThanOrEqual(0.1 * Math.SQRT2 + 1e-4);
        expect(out.minEdge).toBeGreaterThan(1e-4);
        expect(out.flipped).toBe(0);
        expect(out.offCube).toBeLessThan(1e-5);
    });

    it('dices a scene for the tile path tracer\'s camera, keeping each triangle\'s material, closed, and refusing over its cap', () => {
        expect(out.sceneOk).toBe(1);
        expect(out.sceneTris).toBeGreaterThan(100);
        expect(out.sceneMatSize).toBe(out.sceneTris);
        expect(out.sceneMatWrong).toBe(0);
        expect(out.sceneOpen).toBe(0);
        expect(out.sceneRefused).toBe(1);
    });

    it('ignores input vertices that no triangle uses', () => {
        expect(out.partialOk).toBe(1);
        expect(out.partialTris).toBeGreaterThan(30);
        expect(out.partialBad).toBe(0);
    });

    it('moves a plane by exactly a constant height', () => {
        expect(out.liftTris).toBeGreaterThan(20);
        expect(out.liftErr).toBeLessThan(1e-5);
    });

    it('with a camera, dices near surfaces finer than far ones, near the asked pixels a segment, without cracks', () => {
        expect(out.farMeanEdge / out.nearMeanEdge).toBeGreaterThan(5);
        expect(out.pxEdgeP50).toBeGreaterThan(1.0);
        expect(out.pxEdgeP50).toBeLessThan(6.0);
        expect(out.pxEdgeP95).toBeLessThan(10.0);
        expect(out.roadOpen).toBe(0); // open edges other than the strip's own outline
        expect(out.limitedOk).toBe(0);
        expect(out.limitedError).toMatch(/over the limit of 100/);
    });
});
