/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The sped-up native kernels against straightforward references, compiled with the real clang++ (through the native
 * build cache) from C++ held in this test:
 * - SB-Rig's average geodesic distance (pruned farthest-point sampling, then the full fields in parallel) is
 *   bit-identical to running the 48 Dijkstra searches one by one;
 * - the visual hull carves the whole volume (a hull larger than maxPoints is carved on a coarser grid, top to bottom,
 *   never cut off part way), and block culling gives exactly the voxels testing every voxel gives.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags } from '../src/node/3d-engine/native-build-cache';

const INCLUDE = path.resolve(__dirname, '../src/native/3d-engine/include');

async function runCpp(name: string, source: string): Promise<string> {
    const built = await compileNativeCached({ sourceCode: source, includeDirs: [INCLUDE], flags: defaultNativeFlags(['-pthread']), libs: ['-lz'], name });
    return execFileSync(built.binaryPath, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

describe('native kernel speedups keep their results', () => {
    it('SB-Rig AGD equals the sequential 48-search reference, bit for bit', async () => {
        const out = await runCpp('agd_reference_check', `
#include "scratchbox_sb_rig.hpp"
#include <cstdio>
#include <cstring>
using namespace scratchbox;
using namespace scratchbox::sb_rig;

// The previous algorithm: each farthest-point source gets a full Dijkstra, one after another.
static AgdField referenceAgd(const WeldedGraph& g, int samples) {
    AgdField f;
    const auto& main = g.mainVertices;
    std::vector<float> dist;
    f.diameter = Geodesics::run(g, {main.front()}, dist);
    auto argmax = [&](const std::vector<float>& field) { uint32_t best = main.front(); for (uint32_t v : main) if (field[v] > field[best]) best = v; return best; };
    uint32_t source = argmax(dist);
    f.samples = std::min<int>(samples, static_cast<int>(main.size()));
    std::vector<double> sum(g.size(), 0.0);
    std::vector<float> nearest(g.size(), kInf);
    for (int s = 0; s < f.samples; ++s) {
        f.diameter = std::max(f.diameter, Geodesics::run(g, {source}, dist));
        for (uint32_t v : main) { sum[v] += dist[v]; nearest[v] = std::min(nearest[v], dist[v]); }
        source = argmax(nearest);
    }
    f.value.assign(g.size(), -1.0f);
    double lo = std::numeric_limits<double>::max(), hi = std::numeric_limits<double>::lowest();
    for (uint32_t v : main) { lo = std::min(lo, sum[v]); hi = std::max(hi, sum[v]); }
    double range = hi - lo;
    for (uint32_t v : main) f.value[v] = range > 0.0 ? static_cast<float>((sum[v] - lo) / range) : 0.0f;
    f.rawRange = static_cast<float>(range / std::max(f.samples, 1));
    return f;
}

int main() {
    // a lumpy sphere, so geodesics are not symmetric
    auto mesh = geometry::ScratchboxMesh::createSphere(1.0f, 90, 180);
    for (auto& v : mesh.vertices) {
        const auto p = v.position;
        const float bump = 1.0f + 0.25f * std::sin(3.0f * p.x) * std::cos(2.0f * p.y) + 0.4f * std::max(0.0f, p.z);
        v.position = p * bump;
    }
    WeldedGraph g = WeldedGraph::build(mesh, 1e-4f, 0.0f);
    AgdField a = computeAgd(g, 48), b = referenceAgd(g, 48);
    const bool same = a.value.size() == b.value.size()
        && std::memcmp(a.value.data(), b.value.data(), a.value.size() * sizeof(float)) == 0
        && std::memcmp(&a.rawRange, &b.rawRange, sizeof(float)) == 0
        && std::memcmp(&a.diameter, &b.diameter, sizeof(float)) == 0 && a.samples == b.samples;
    std::printf("vertices=%zu samples=%d identical=%d\\n", g.mainVertices.size(), a.samples, same ? 1 : 0);
    return 0;
}
`);
        const m = /vertices=(\d+) samples=(\d+) identical=(\d)/.exec(out);
        expect(m, out).not.toBeNull();
        expect(Number(m![1])).toBeGreaterThan(10_000);
        expect(Number(m![2])).toBe(48);
        expect(m![3]).toBe('1');
    }, 300_000);

    it('the visual hull covers the whole subject when it is larger than maxPoints, and block culling changes nothing', async () => {
        const out = await runCpp('visual_hull_check', `
#include "scratchbox_visual_hull.hpp"
#include <cstdio>
#include <cstring>
using namespace scratchbox;
using namespace scratchbox::visual_hull;

// Four cameras 3 m out on the horizontal axes, looking at a 0.5 m x 1.8 m upright capsule-ish silhouette.
static VisualHullCamera camera(float angle) {
    VisualHullCamera c;
    c.width = 160; c.height = 240; c.fx = c.fy = 200.0f; c.cx = 80.0f; c.cy = 120.0f;
    const float s = std::sin(angle), co = std::cos(angle);
    // camera at (3 s, 0.9, 3 co) looking at (0, 0.9, 0): forward = (-s, 0, -co), right = (co, 0, -s), down = (0, -1, 0)
    const float px = 3 * s, py = 0.9f, pz = 3 * co;
    const float R[3][3] = {{co, 0, -s}, {0, -1, 0}, {-s, 0, -co}};
    for (int r = 0; r < 3; ++r) {
        c.w2c[r * 4 + 0] = R[r][0]; c.w2c[r * 4 + 1] = R[r][1]; c.w2c[r * 4 + 2] = R[r][2];
        c.w2c[r * 4 + 3] = -(R[r][0] * px + R[r][1] * py + R[r][2] * pz);
    }
    c.mask.assign(c.width * c.height, 0);
    c.rgb.assign(c.width * c.height * 3, 200);
    for (uint32_t v = 0; v < c.height; ++v)
        for (uint32_t u = 0; u < c.width; ++u) {
            // back-project the pixel to the plane through the axis: x_world_offset = (u - cx) * 3 / fx, y = 0.9 - (v - cy) * 3 / fy
            const float xo = (u - c.cx) * 3.0f / c.fx, yw = 0.9f - (v - c.cy) * 3.0f / c.fy;
            if (std::fabs(xo) < 0.25f && yw > 0.0f && yw < 1.8f) c.mask[v * c.width + u] = 255;
        }
    return c;
}

int main() {
    std::vector<VisualHullCamera> cams;
    for (int i = 0; i < 4; ++i) cams.push_back(camera(i * 1.5707963f));
    VisualHullOptions o;
    o.voxelSize = 0.02f;
    o.minForegroundViews = 4;
    o.maxPoints = 1000000;
    auto culled = VisualHullCarver::carveAtStep(cams, o, 0.02f, true);
    auto brute = VisualHullCarver::carveAtStep(cams, o, 0.02f, false);
    bool same = culled.size() == brute.size();
    for (size_t i = 0; same && i < culled.size(); ++i)
        same = std::memcmp(&culled[i].position, &brute[i].position, sizeof(Vec3)) == 0 && std::memcmp(&culled[i].color, &brute[i].color, sizeof(Vec3)) == 0;
    o.maxPoints = 2000;
    auto capped = VisualHullCarver::carve(cams, o);
    float lo = 1e9f, hi = -1e9f;
    for (const auto& s : capped) { lo = std::min(lo, s.position.y); hi = std::max(hi, s.position.y); }
    float flo = 1e9f, fhi = -1e9f;
    for (const auto& s : brute) { flo = std::min(flo, s.position.y); fhi = std::max(fhi, s.position.y); }
    std::printf("full=%zu identical=%d capped=%zu ylo=%.3f yhi=%.3f fullylo=%.3f fullyhi=%.3f\\n", brute.size(), same ? 1 : 0, capped.size(), lo, hi, flo, fhi);
    return 0;
}
`);
        const m = /full=(\d+) identical=(\d) capped=(\d+) ylo=([-\d.]+) yhi=([-\d.]+) fullylo=([-\d.]+) fullyhi=([-\d.]+)/.exec(out);
        expect(m, out).not.toBeNull();
        const [full, identical, capped, ylo, yhi, fullYlo, fullYhi] = m!.slice(1).map(Number);
        expect(full).toBeGreaterThan(20_000);
        expect(identical).toBe(1);
        expect(capped).toBeGreaterThan(500);
        expect(capped).toBeLessThanOrEqual(2000);
        // the capped hull still spans the subject from bottom to top (within a coarse voxel)
        expect(ylo).toBeLessThan(fullYlo + 0.12);
        expect(yhi).toBeGreaterThan(fullYhi - 0.12);
    }, 300_000);
});
