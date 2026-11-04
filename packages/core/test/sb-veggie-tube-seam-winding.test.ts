/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * SB-Veggie's tubes and leaf cards (scratchbox_sb_veggie.hpp): every trunk and branch ring has a seam column at u = 1, so
 * no strip of bark runs its u backwards from (n-1)/n to 0, and every wood and leaf triangle turns counter-clockwise about
 * its own vertex normals (the trunk's quads and the leaf undersides and petioles were wound the other way). The default
 * tree is measured from the GLB the engine writes; posed trees, both underside normal blends and a planted cluster from
 * the native evaluator. docs/processes/sb_veggie_tube_seam_and_winding_2026-11-02.md.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { parseGlb, readAccessor } from './helpers/clay-glb-render';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const INCLUDE = path.join(REPO, 'packages/core/src/native/3d-engine/include');

const PROBE = `#include "scratchbox_engine.hpp"
#include "scratchbox_sb_veggie.hpp"
#include "scratchbox_io.hpp"
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <string>
using namespace scratchbox; using namespace scratchbox::math; using namespace scratchbox::geometry; using namespace scratchbox::sb_veggie;
static size_t cw(const std::vector<Vec3>& P, const std::vector<Vec3>& N, const std::vector<uint32_t>& I) {
    size_t c = 0;
    for (size_t i = 0; i + 2 < I.size(); i += 3) {
        Vec3 f = (P[I[i + 1]] - P[I[i]]).cross(P[I[i + 2]] - P[I[i]]);
        if (f.lengthSquared() > 1e-24f && f.dot(N[I[i]] + N[I[i + 1]] + N[I[i + 2]]) < 0.0f) ++c;
    }
    return c;
}
static size_t cwMesh(const ScratchboxMesh& m) {
    std::vector<Vec3> P, N;
    for (const auto& v : m.vertices) { P.push_back(v.position); N.push_back(v.normal); }
    return cw(P, N, m.indices);
}
static void tree(const char* name, const SbVeggieParams& p) {
    SbVeggieTemplate t = SbVeggieModelBuilder::buildCanonicalTemplate(p.morphology);
    auto d = SbVeggieEvaluator::evaluateDecomposed(t, p, true);
    std::printf("{\\"case\\":\\"%s\\",\\"woodCw\\":%zu,\\"woodTris\\":%zu,\\"leafCw\\":%zu,\\"leafTris\\":%zu}\\n", name, cwMesh(d.woodMesh),
                d.woodMesh.indices.size() / 3, cwMesh(d.foliageMesh), d.foliageMesh.indices.size() / 3);
}
int main(int, char** argv) {
    SbVeggieParams params = SbVeggieParams::createNeutral();
    SbVeggieTemplate tmpl = SbVeggieModelBuilder::buildCanonicalTemplate(params.morphology);
    auto d = SbVeggieEvaluator::evaluateDecomposed(tmpl, params, true);
    auto glb = io::GlbWriter::serializeMultiMeshToGlb({d.woodMesh, d.foliageMesh});
    std::ofstream(argv[1], std::ios::binary).write(reinterpret_cast<const char*>(glb.data()), static_cast<std::streamsize>(glb.size()));
    // seam vertices: a second vertex at a ring vertex's exact position, with its normal, skin weights and shape basis
    std::map<std::string, std::vector<size_t>> at;
    for (size_t i = 0; i < tmpl.canonicalVertices.size(); ++i)
        at[std::string(reinterpret_cast<const char*>(&tmpl.canonicalVertices[i].position), sizeof(Vec3))].push_back(i);
    size_t pairs = 0, differ = 0;
    for (const auto& [k, v] : at) {
        if (v.size() != 2) continue;
        ++pairs;
        const auto &a = tmpl.canonicalVertices[v[0]], &b = tmpl.canonicalVertices[v[1]];
        const auto &sa = tmpl.skinWeights[v[0]], &sb = tmpl.skinWeights[v[1]];
        bool same = !std::memcmp(&a.normal, &b.normal, sizeof(Vec3)) && !std::memcmp(sa.jointIndices, sb.jointIndices, sizeof(sa.jointIndices)) &&
                    !std::memcmp(sa.weights, sb.weights, sizeof(sa.weights)) && std::fabs(std::fabs(a.uv.x - b.uv.x) - 1.0f) < 1e-6f;
        for (size_t m = 0; m < tmpl.shapeBasis.size(); ++m) same = same && !std::memcmp(&tmpl.shapeBasis[m][v[0]], &tmpl.shapeBasis[m][v[1]], sizeof(Vec3));
        if (!same) ++differ;
    }
    std::printf("{\\"case\\":\\"template\\",\\"vertices\\":%zu,\\"skinWeights\\":%zu,\\"seamPairs\\":%zu,\\"seamPairsDiffering\\":%zu}\\n",
                tmpl.canonicalVertices.size(), tmpl.skinWeights.size(), pairs, differ);
    SbVeggieParams posed = params;
    for (int k = 0; k < 16; ++k) posed.beta[k] = 0.6f * std::sin(1.3f * k + 0.4f);
    posed.windVector = Vec3(1.0f, 0.0f, 0.4f); posed.windTimeSeconds = 2.0f;
    for (int i = 0; i < 8; ++i) { posed.scaffoldIK[i].azimuthOffset = 0.2f * i; posed.scaffoldIK[i].elevationOffset = -0.1f; posed.scaffoldIK[i].reachScale = 1.3f; }
    tree("posed", posed);
    SbVeggieParams flipped = params; flipped.morphology.blade.undersideNormalBlend = 0.0f; tree("undersideNormalBlend 0", flipped);
    SbVeggieParams lit = params; lit.morphology.blade.undersideNormalBlend = 1.0f; tree("undersideNormalBlend 1", lit);
    for (float blend : {0.0f, 0.7f}) {
        SbVeggieClusterParams cp; cp.morphology.blade.undersideNormalBlend = blend;
        auto c = SbVeggieFoliage::buildCluster(cp);
        std::printf("{\\"case\\":\\"cluster %.1f\\",\\"leafCw\\":%zu,\\"leafTris\\":%zu}\\n", blend, cw(c.positions, c.normals, c.indices), c.indices.size() / 3);
    }
}
`;

type Prim = { name: string; P: Float64Array; N: Float64Array; UV: Float64Array; I: Float64Array };

function primitives(buf: Buffer): Prim[] {
    const { json, bin } = parseGlb(buf);
    return json.meshes.map((m: any) => {
        const pr = m.primitives[0];
        const a = pr.attributes;
        return { name: m.name, P: readAccessor(json, bin, a.POSITION).data, N: readAccessor(json, bin, a.NORMAL).data, UV: readAccessor(json, bin, a.TEXCOORD_0).data, I: readAccessor(json, bin, pr.indices).data };
    });
}

/** Triangles whose face turns clockwise about the sum of their three vertex normals. */
function clockwise({ P, N, I }: Prim): number {
    let n = 0;
    for (let t = 0; t < I.length; t += 3) {
        const [a, b, c] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
        const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
        const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const s = f[0] * (N[a] + N[b] + N[c]) + f[1] * (N[a + 1] + N[b + 1] + N[c + 1]) + f[2] * (N[a + 2] + N[b + 2] + N[c + 2]);
        if (Math.hypot(f[0], f[1], f[2]) > 1e-12 && s < 0) n++;
    }
    return n;
}

/**
 * Bark direction: each triangle's dP/du, compared with its neighbours' across every edge they share (vertices welded by
 * position, so the seam joins its two columns). A strip mapped backwards turns ~180 degrees from its neighbours; a 4-sided
 * twig's neighbouring strips are ~90 degrees apart by geometry.
 */
function uvAgainstNeighbours({ P, UV, I }: Prim): { against: number; maxEdgeDu: number } {
    const key = (v: number) => `${P[v * 3].toFixed(5)},${P[v * 3 + 1].toFixed(5)},${P[v * 3 + 2].toFixed(5)}`;
    const dPdu: number[][] = [];
    let maxEdgeDu = 0;
    const edges = new Map<string, number[]>();
    for (let t = 0; t < I.length / 3; t++) {
        const v = [I[t * 3], I[t * 3 + 1], I[t * 3 + 2]];
        const du1 = UV[v[1] * 2] - UV[v[0] * 2], dv1 = UV[v[1] * 2 + 1] - UV[v[0] * 2 + 1];
        const du2 = UV[v[2] * 2] - UV[v[0] * 2], dv2 = UV[v[2] * 2 + 1] - UV[v[0] * 2 + 1];
        maxEdgeDu = Math.max(maxEdgeDu, Math.abs(du1), Math.abs(du2), Math.abs(du2 - du1));
        const det = du1 * dv2 - du2 * dv1;
        dPdu.push([0, 1, 2].map((k) => ((P[v[1] * 3 + k] - P[v[0] * 3 + k]) * dv2 - (P[v[2] * 3 + k] - P[v[0] * 3 + k]) * dv1) / det));
        const w = v.map(key);
        for (const [x, y] of [[w[0], w[1]], [w[1], w[2]], [w[2], w[0]]]) {
            const e = x < y ? `${x}|${y}` : `${y}|${x}`;
            edges.set(e, [...(edges.get(e) ?? []), t]);
        }
    }
    const bad = new Set<number>();
    for (const ts of edges.values()) {
        if (ts.length !== 2) continue;
        const [a, b] = [dPdu[ts[0]], dPdu[ts[1]]];
        const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]));
        if (cos < -0.5) { bad.add(ts[0]); bad.add(ts[1]); }
    }
    return { against: bad.size, maxEdgeDu };
}

describe('SB-Veggie tube seams and winding', () => {
    let work: string;
    let glb: Buffer;
    let cases: Record<string, any>;

    beforeAll(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-veggie-seam-'));
        const src = path.join(work, 'probe.cpp'), bin = path.join(work, 'probe'), out = path.join(work, 'tree.glb');
        fs.writeFileSync(src, PROBE);
        const c = spawnSync(process.env.CXX || 'clang++', ['-std=c++20', '-O2', '-I' + INCLUDE, src, '-o', bin], { encoding: 'utf8' });
        expect(c.status, c.stderr).toBe(0);
        const r = spawnSync(bin, [out], { encoding: 'utf8', maxBuffer: 1 << 24 });
        expect(r.status, r.stderr).toBe(0);
        glb = fs.readFileSync(out);
        cases = Object.fromEntries(r.stdout.trim().split('\n').map((l) => JSON.parse(l)).map((j) => [j.case, j]));
    }, 180_000);

    afterAll(() => {
        if (work) fs.rmSync(work, { recursive: true, force: true });
    });

    it('the default tree\'s GLB: bark u never wraps, and wood and leaves wind counter-clockwise about their normals', () => {
        const [wood, leaves] = primitives(glb);
        expect(wood.name).toBe('SbVeggie_Botanical_Wood');
        expect(leaves.name).toBe('SbVeggie_Botanical_Foliage');
        expect(wood.P.length / 3).toBe(2993);
        expect(wood.I.length / 3).toBe(4064);
        expect(clockwise(wood)).toBe(0);
        expect(leaves.I.length / 3).toBe(275600);
        expect(clockwise(leaves)).toBe(0);
        const uv = uvAgainstNeighbours(wood);
        expect(uv.against).toBe(0);
        // a wrapped strip spans (n-1)/n of u (3/4 on a 4-sided twig); the widest legitimate edge is a cap fan's 0.5
        expect(uv.maxEdgeDu).toBeLessThanOrEqual(0.5 + 1e-6);
    });

    it('seam vertices carry their first column\'s normal, skin and shape basis; posed trees, both underside blends and planted clusters wind counter-clockwise', () => {
        const t = cases.template;
        expect(t.skinWeights).toBe(t.vertices);
        // 25 trunk rings, 8 x 5 scaffold, 24 x 4 secondary, 48 x 4 tertiary, 24 x 3 twig
        expect(t.seamPairs).toBe(425);
        expect(t.seamPairsDiffering).toBe(0);
        for (const name of ['posed', 'undersideNormalBlend 0', 'undersideNormalBlend 1']) {
            expect(cases[name].woodTris, name).toBe(4064);
            expect(cases[name].woodCw, name).toBe(0);
            expect(cases[name].leafTris, name).toBeGreaterThan(100_000);
            expect(cases[name].leafCw, name).toBe(0);
        }
        for (const name of ['cluster 0.0', 'cluster 0.7']) {
            expect(cases[name].leafTris, name).toBeGreaterThan(100);
            expect(cases[name].leafCw, name).toBe(0);
        }
    });
});
