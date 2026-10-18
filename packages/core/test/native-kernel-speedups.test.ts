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
 *   never cut off part way), and block culling gives exactly the voxels testing every voxel gives;
 * - the scan fitter's plane index returns every pair the coplanar-merge and opposed-sheet tests accept (normals at cell
 *   edges, centroids kilometres out, offsets at the tolerance, unusable normals and points), and the indexed coplanar
 *   merge makes the same merges in the same order as comparing every pair, to the bit.
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

    it('scan_fit: the plane index misses no accepted pair, and the indexed merge equals comparing every pair, to the bit', async () => {
        const out = await runCpp('scan_fit_merge_check', `
#include "scratchbox_scan_geom.hpp"
#include <cstdio>
#include <cstring>
#include <unordered_set>
using namespace scratchbox;
namespace sg = scratchbox::scan_geom;
using math::Vec3;

struct Item { sg::Plane pl; Vec3 c; double w{1}, spread{0}; };

static Vec3 unitv(double x, double y, double z) { const double l = std::sqrt(x * x + y * y + z * z); return Vec3(float(x / l), float(y / l), float(z / l)); }

static std::vector<Item> makeItems(uint64_t seed, size_t n) {
    std::mt19937_64 rng(seed);
    std::uniform_real_distribution<double> U(-1, 1);
    std::vector<Vec3> axes = {unitv(1, 0, 0), unitv(0, 1, 0), unitv(0, 0, -1), unitv(1, 1, 0), unitv(0.0261, 1, 0)};
    for (int k = 0; k < 15; ++k) axes.push_back(unitv(U(rng), U(rng), U(rng)));
    std::vector<Vec3> bases;
    for (size_t k = 0; k < axes.size(); ++k) bases.push_back(Vec3(float(U(rng) * 3000), float(U(rng) * 300), float(U(rng) * 3000)));
    std::vector<Item> items;
    for (size_t i = 0; i < n; ++i) {
        const size_t k = rng() % axes.size();
        const Vec3 a = axes[k];
        // tilted up to 4 degrees (past the 3-degree merge angle), sometimes opposed
        const double t = U(rng) * 0.06;
        Vec3 nrm = unitv(a.x + t * U(rng), a.y + t * U(rng), a.z + t * U(rng));
        if (rng() % 5 == 0) nrm = nrm * -1.0f;
        Vec3 c = bases[k] + Vec3(float(U(rng) * 20), float(U(rng) * 20), float(U(rng) * 20));
        c = c - nrm * nrm.dot(c - bases[k]) + nrm * float(U(rng) * 0.05);
        Item it;
        it.pl = {nrm, nrm.dot(c) + U(rng) * 0.02};
        it.c = c;
        it.w = 1 + (rng() % 7);
        items.push_back(it);
    }
    items[7].pl.n = items[7].pl.n * 1.01f;                                   // not unit length
    items[11].c = Vec3(std::numeric_limits<float>::quiet_NaN(), 0, 0);        // not a point
    return items;
}

static bool tryMerge(std::vector<Item>& v, size_t a, size_t b) {
    const Item& A = v[a];
    const Item& B = v[b];
    const double sp = std::max({A.spread, B.spread, std::fabs(A.pl.dist(B.c)), std::fabs(B.pl.dist(A.c))});
    if (sp > 0.022) return false;
    Item m;
    m.w = A.w + B.w;
    m.c = (A.c * float(A.w) + B.c * float(B.w)) / float(m.w);
    const Vec3 s = A.pl.n * float(A.w) + B.pl.n * float(B.w);
    m.pl.n = s.normalized();
    m.pl.d = m.pl.n.dot(m.c);
    m.spread = sp;
    v[a] = m;
    return true;
}

int main() {
    const float cosM = float(std::cos(3.0 * M_PI / 180)), cosS = 0.97f;
    const double offM = 0.03, gap = 0.04;
    size_t pairs = 0, missed = 0, sheetPairs = 0, sheetMissed = 0;
    {
        const auto items = makeItems(5, 3000);
        sg::PlanePointIndex idx(sg::PlanePointIndex::chordForDot(cosM)), sidx(sg::PlanePointIndex::chordForDot(cosS));
        for (size_t i = 0; i < items.size(); ++i) { idx.insert(uint32_t(i), items[i].pl.n, items[i].c); sidx.insert(uint32_t(i), items[i].pl.n, items[i].c); }
        std::vector<uint8_t> got(items.size()), sgot(items.size());
        for (size_t a = 0; a < items.size(); ++a) {
            const auto& A = items[a];
            std::fill(got.begin(), got.end(), 0);
            std::fill(sgot.begin(), sgot.end(), 0);
            idx.query(A.pl.n, A.pl.n, A.pl.d, offM, [&](uint32_t b) { got[b] = 1; });
            const Vec3 back = A.pl.n * -1.0f;
            sidx.query(back, back, -A.pl.d, gap, [&](uint32_t b) { sgot[b] = 1; });
            for (size_t b = 0; b < items.size(); ++b) {
                if (b == a) continue;
                const auto& B = items[b];
                if (!(A.pl.n.dot(B.pl.n) < cosM) && !(std::fabs(A.pl.dist(B.c)) > offM)) { ++pairs; if (!got[b]) ++missed; }
                if (!(A.pl.n.dot(B.pl.n) > -cosS) && !(std::fabs(A.pl.dist(B.c)) > gap)) { ++sheetPairs; if (!sgot[b]) ++sheetMissed; }
            }
        }
    }
    // the merge: the previous loop over every pair, against mergeCoplanarInOrder
    size_t merges = 0, fails = 0, passes = 0;
    bool same = true;
    for (uint64_t seed : {1, 2, 3}) {
        std::vector<Item> ref = makeItems(seed, 2500), fast = ref;
        std::vector<std::pair<size_t, size_t>> refLog, fastLog;
        const size_t R0 = ref.size();
        std::vector<uint8_t> alive(R0, 1);
        std::vector<uint64_t> stamp(R0);
        for (size_t i = 0; i < R0; ++i) stamp[i] = i;
        uint64_t nextStamp = R0;
        std::unordered_set<uint64_t> failed;
        bool merged = true;
        while (merged) {
            merged = false; ++passes;
            for (size_t a = 0; a < R0; ++a) {
                if (!alive[a]) continue;
                for (size_t b = a + 1; b < R0; ++b) {
                    if (!alive[b]) continue;
                    if (ref[a].pl.n.dot(ref[b].pl.n) < cosM) continue;
                    if (std::fabs(ref[a].pl.dist(ref[b].c)) > offM || std::fabs(ref[b].pl.dist(ref[a].c)) > offM) continue;
                    const uint64_t key = (stamp[a] << 32) ^ stamp[b];
                    if (failed.count(key)) continue;
                    if (!tryMerge(ref, a, b)) { failed.insert(key); ++fails; continue; }
                    refLog.push_back({a, b});
                    stamp[a] = nextStamp++;
                    alive[b] = 0;
                    merged = true;
                }
            }
        }
        const auto fastAlive = sg::mergeCoplanarInOrder(R0, cosM, offM,
            [&](size_t i) -> const sg::Plane& { return fast[i].pl; },
            [&](size_t i) -> const Vec3& { return fast[i].c; },
            [&](size_t a, size_t b) { if (!tryMerge(fast, a, b)) return false; fastLog.push_back({a, b}); return true; });
        merges += refLog.size();
        same = same && refLog == fastLog && alive == fastAlive;
        for (size_t i = 0; same && i < R0; ++i)
            same = std::memcmp(&ref[i].pl.n, &fast[i].pl.n, sizeof(Vec3)) == 0 && std::memcmp(&ref[i].pl.d, &fast[i].pl.d, sizeof(double)) == 0 &&
                   std::memcmp(&ref[i].c, &fast[i].c, sizeof(Vec3)) == 0;
    }
    std::printf("pairs=%zu missed=%zu sheetPairs=%zu sheetMissed=%zu merges=%zu fails=%zu passes=%zu same=%d\\n", pairs, missed, sheetPairs, sheetMissed, merges, fails, passes, same ? 1 : 0);
    return 0;
}
`);
        const m = /pairs=(\d+) missed=(\d+) sheetPairs=(\d+) sheetMissed=(\d+) merges=(\d+) fails=(\d+) passes=(\d+) same=(\d)/.exec(out);
        expect(m, out).not.toBeNull();
        const [pairs, missed, sheetPairs, sheetMissed, merges, fails, passes, same] = m!.slice(1).map(Number);
        expect(pairs).toBeGreaterThan(1000);
        expect(missed).toBe(0);
        expect(sheetPairs).toBeGreaterThan(1000);
        expect(sheetMissed).toBe(0);
        // a run that exercises the order: many merges, refused pairs, and passes after the first
        expect(merges).toBeGreaterThan(500);
        expect(fails).toBeGreaterThan(20);
        expect(passes).toBeGreaterThan(6);
        expect(same).toBe(1);
    }, 300_000);
});
