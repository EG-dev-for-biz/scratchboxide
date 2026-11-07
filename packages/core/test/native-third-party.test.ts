/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Vendored native third-party code (packages/core/src/native/3d-engine/third_party, native-third-party.ts):
 * - the licence gate passes on the tree, and fails on a GPL file, an LGPL SPDX line, a non-commercial licence, a
 *   library with no licence file, a modified MPL file and a loose file;
 * - the root NOTICE.md's generated section matches every VENDORED.md and licence (no drift);
 * - a vendored library builds once into a static archive (ar magic), hits the cache after, rebuilds when a source
 *   changes, compiles C sources as C, and a compile error throws;
 * - meshoptimizer links through compileSource({ vendored }) and, through scratchbox_meshopt.hpp, simplifies a closed,
 *   seamed, displaced torus to a triangle target and to an absolute error bound (its quadric estimate within the
 *   bound, the input surface measured independently within 1.7x it), keeps it closed, lowers a shuffled mesh's ACMR, and writes a GLB with glTF magic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    applyNativeNotices, buildVendoredLibrary, checkThirdPartyLicences, nativeThirdPartyRoot, readVendoredLibraries, renderNativeNotices
} from '../src/node/3d-engine/native-third-party';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { NativeBuildError } from '../src/node/3d-engine/native-build-cache';

const repoRoot = path.resolve(__dirname, '../../..');
const thirdParty = path.join(repoRoot, 'packages/core/src/native/3d-engine/third_party');
let dir: string;
const savedCache = process.env.SCRATCHBOX_NATIVE_BUILD_CACHE;

beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-third-party-')));
    process.env.SCRATCHBOX_NATIVE_BUILD_CACHE = path.join(dir, 'cache');
});

afterAll(() => {
    if (savedCache === undefined) delete process.env.SCRATCHBOX_NATIVE_BUILD_CACHE;
    else process.env.SCRATCHBOX_NATIVE_BUILD_CACHE = savedCache;
    fs.rmSync(dir, { recursive: true, force: true });
});

const MIT = `MIT License\n\nCopyright (c) 2020 Someone\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n`;

function vendoredMd(name: string, spdx: string, changes = 'None.', sources = 'src/*.cpp src/*.c', license = 'LICENSE'): string {
    return `---\nname: ${name}\nupstream: https://example.com/${name}\nversion: v1.0\ncommit: 0123456789abcdef\nvendored: 2026-11-07\nspdx: ${spdx}\nlicense: ${license}\ncopyright: Copyright (c) 2020 Someone\nsources: ${sources}\n---\n\n# ${name}\n\n## Local changes\n\n${changes}\n`;
}

/** A third_party root holding one small MIT library (a .cpp and a .c), for the gate and the builder. */
function fakeRoot(tag: string): string {
    const root = path.join(dir, `tp-${tag}`);
    const lib = path.join(root, 'tiny');
    fs.mkdirSync(path.join(lib, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'README.md'), 'ours: GPL code never comes in\n');
    fs.writeFileSync(path.join(lib, 'LICENSE'), MIT);
    fs.writeFileSync(path.join(lib, 'VENDORED.md'), vendoredMd('tiny', 'MIT'));
    fs.writeFileSync(path.join(lib, 'src/tiny.h'), '#ifdef __cplusplus\nextern "C" {\n#endif\nint tiny_c(int);\nint tiny_cpp(int);\n#ifdef __cplusplus\n}\n#endif\n');
    fs.writeFileSync(path.join(lib, 'src/tiny.cpp'), '#include "tiny.h"\nextern "C" int tiny_cpp(int x) { return x * 3; }\n');
    // `new` is an identifier in C, a keyword in C++: this file only compiles as C
    fs.writeFileSync(path.join(lib, 'src/tiny_c.c'), '#include "tiny.h"\nint tiny_c(int x) { int new = x + 1; return new; }\n');
    return root;
}

describe('licence gate', () => {
    it('passes on the vendored tree, which has at least meshoptimizer', () => {
        expect(checkThirdPartyLicences(thirdParty)).toEqual([]);
        const libs = readVendoredLibraries(thirdParty);
        const mo = libs.find(l => l.name === 'meshoptimizer')!;
        expect(mo.spdx).toBe('MIT');
        expect(mo.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(mo.unmodified).toBe(true);
        expect(nativeThirdPartyRoot()).toBe(thirdParty);
    });

    it('fails on GPL, LGPL SPDX, non-commercial, missing licence, modified MPL and loose files', () => {
        const ok = fakeRoot('ok');
        expect(checkThirdPartyLicences(ok)).toEqual([]);

        const gpl = fakeRoot('gpl');
        fs.writeFileSync(path.join(gpl, 'tiny/src/extra.cpp'), '/* This program is free software; you can redistribute it under the terms of the GNU General Public License */\n');
        expect(checkThirdPartyLicences(gpl).join('\n')).toMatch(/extra\.cpp: carries GNU GPL-family licence text/);

        const lgpl = fakeRoot('lgpl');
        fs.writeFileSync(path.join(lgpl, 'tiny/src/extra.h'), '// SPDX-License-Identifier: LGPL-2.1-or-later\n');
        expect(checkThirdPartyLicences(lgpl).join('\n')).toMatch(/extra\.h: SPDX-License-Identifier LGPL-2\.1-or-later is not allowed/);

        const nc = fakeRoot('nc');
        fs.writeFileSync(path.join(nc, 'tiny/src/weights.txt'), 'Licensed CC BY-NC 4.0, for non-commercial research only\n');
        expect(checkThirdPartyLicences(nc).join('\n')).toMatch(/weights\.txt: carries a non-commercial licence/);

        const nolic = fakeRoot('nolic');
        fs.rmSync(path.join(nolic, 'tiny/LICENSE'));
        expect(checkThirdPartyLicences(nolic).join('\n')).toMatch(/tiny: licence file LICENSE not found/);

        const wrongSpdx = fakeRoot('agpl');
        fs.writeFileSync(path.join(wrongSpdx, 'tiny/VENDORED.md'), vendoredMd('tiny', 'AGPL-3.0-only'));
        expect(checkThirdPartyLicences(wrongSpdx).join('\n')).toMatch(/SPDX "AGPL-3\.0-only" has ids not allowed/);

        const mpl = fakeRoot('mpl');
        fs.writeFileSync(path.join(mpl, 'tiny/LICENSE'), 'Mozilla Public License Version 2.0\n==================================\n');
        fs.writeFileSync(path.join(mpl, 'tiny/VENDORED.md'), vendoredMd('tiny', 'MPL-2.0', '- src/tiny.cpp: a build fix'));
        fs.appendFileSync(path.join(mpl, 'tiny/src/tiny.cpp'), '// Modified by Scratchbox LLC, 2026: a build fix\n');
        const mplProblems = checkThirdPartyLicences(mpl).join('\n');
        expect(mplProblems).toMatch(/MPL-2\.0 code may only be vendored unmodified/);
        expect(mplProblems).toMatch(/tiny\.cpp: an MPL-2\.0 file was modified/);

        const loose = fakeRoot('loose');
        fs.writeFileSync(path.join(loose, 'stray.h'), 'int x;\n');
        expect(checkThirdPartyLicences(loose).join('\n')).toMatch(/stray\.h: a file outside any library folder/);
    });
});

describe('NOTICE.md', () => {
    it('has the generated native section and it matches every VENDORED.md (run npm run notices:native)', () => {
        const notice = fs.readFileSync(path.join(repoRoot, 'NOTICE.md'), 'utf8');
        expect(applyNativeNotices(notice, renderNativeNotices(thirdParty))).toBe(notice);
        expect(notice).toContain('### meshoptimizer (v1.3)');
        expect(notice).toContain('Permission is hereby granted, free of charge');
    });

    it('replaces only its own section, and appends one when there is none', () => {
        const section = renderNativeNotices(fakeRoot('notice'));
        const appended = applyNativeNotices('# Notices\n\nother text\n', section);
        expect(appended.startsWith('# Notices\n\nother text\n\n<!-- BEGIN native-third-party')).toBe(true);
        expect(appended).toContain('### tiny (v1.0)');
        const replaced = applyNativeNotices(`${appended}\ntrailing\n`, renderNativeNotices(thirdParty));
        expect(replaced).not.toContain('### tiny');
        expect(replaced).toContain('### meshoptimizer');
        expect(replaced.endsWith('trailing\n')).toBe(true);
    });
});

describe('vendored library builds', () => {
    it('compiles a library once into an archive, hits after, rebuilds on a source change, builds C as C', async () => {
        const root = fakeRoot('build');
        const cacheRoot = path.join(dir, 'cache-tiny');
        const a = await buildVendoredLibrary('tiny', { root, cacheRoot });
        expect(a.cacheHit).toBe(false);
        expect(a.objectCount).toBe(2);
        expect(fs.readFileSync(a.archivePath).subarray(0, 8).toString('latin1')).toBe('!<arch>\n');
        const b = await buildVendoredLibrary('tiny', { root, cacheRoot });
        expect(b.cacheHit).toBe(true);
        expect(b.archivePath).toBe(a.archivePath);
        // a header the sources include is part of the key
        fs.appendFileSync(path.join(root, 'tiny/src/tiny.h'), '/* changed */\n');
        const c = await buildVendoredLibrary('tiny', { root, cacheRoot });
        expect(c.cacheHit).toBe(false);
        expect(c.key).not.toBe(a.key);

        fs.writeFileSync(path.join(root, 'tiny/src/broken.cpp'), 'int broken( {\n');
        await expect(buildVendoredLibrary('tiny', { root, cacheRoot })).rejects.toBeInstanceOf(NativeBuildError);
    });

    it('builds meshoptimizer (21 objects) into a cached archive', async () => {
        const cacheRoot = path.join(dir, 'cache-mo');
        const a = await buildVendoredLibrary('meshoptimizer', { cacheRoot });
        expect(a.objectCount).toBe(21);
        expect(fs.readFileSync(a.archivePath).subarray(0, 8).toString('latin1')).toBe('!<arch>\n');
        expect((await buildVendoredLibrary('meshoptimizer', { cacheRoot })).cacheHit).toBe(true);
    });
});

const MESHOPT_PROGRAM = String.raw`
#include "scratchbox_geometry.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_meshopt.hpp"
#include <cstdio>
#include <map>
#include <random>
using namespace scratchbox;
using geometry::ScratchboxMesh; using geometry::Vertex; using math::Vec3; using math::Vec2;

// a torus R=10 m, r=3 m, bumped by 0.25 m: UV seams in both directions (the first ring and column repeated)
static ScratchboxMesh torus(int nu, int nv) {
    ScratchboxMesh m("torus");
    for (int i = 0; i <= nu; ++i) for (int j = 0; j <= nv; ++j) {
        double u = 2 * M_PI * (i % nu) / nu, v = 2 * M_PI * (j % nv) / nv;
        double rr = 3.0 + 0.25 * std::sin(5 * u) * std::sin(7 * v);
        Vec3 c(float(10 * std::cos(u)), 0.f, float(10 * std::sin(u)));
        Vec3 n(float(std::cos(u) * std::cos(v)), float(std::sin(v)), float(std::sin(u) * std::cos(v)));
        Vertex vx(c + n * float(rr), n, Vec2(float(i) / nu, float(j) / nv));
        m.addVertex(vx);
    }
    for (int i = 0; i < nu; ++i) for (int j = 0; j < nv; ++j) {
        uint32_t a = i * (nv + 1) + j, b = (i + 1) * (nv + 1) + j;
        m.addTriangle(a, a + 1, b); m.addTriangle(b, a + 1, b + 1);
    }
    return m;
}
static double ptTri(const Vec3& p, const Vec3& a, const Vec3& b, const Vec3& c) {
    // Ericson, closest point on triangle
    Vec3 ab = b - a, ac = c - a, ap = p - a;
    double d1 = ab.dot(ap), d2 = ac.dot(ap); if (d1 <= 0 && d2 <= 0) return (p - a).length();
    Vec3 bp = p - b; double d3 = ab.dot(bp), d4 = ac.dot(bp); if (d3 >= 0 && d4 <= d3) return (p - b).length();
    double vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) { double v = d1 / (d1 - d3); return (p - (a + ab * float(v))).length(); }
    Vec3 cp = p - c; double d5 = ab.dot(cp), d6 = ac.dot(cp); if (d6 >= 0 && d5 <= d6) return (p - c).length();
    double vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) { double w = d2 / (d2 - d6); return (p - (a + ac * float(w))).length(); }
    double va = d3 * d6 - d5 * d4; if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { double w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return (p - (b + (c - b) * float(w))).length(); }
    double den = 1.0 / (va + vb + vc); double v = vb * den, w = vc * den; return (p - (a + ab * float(v) + ac * float(w))).length();
}
// largest distance from the input's vertices to the result's surface
static double deviation(const ScratchboxMesh& in, const ScratchboxMesh& out) {
    double worst = 0;
    for (size_t k = 0; k < in.vertices.size(); k += 7) {
        double best = 1e30; const Vec3& p = in.vertices[k].position;
        for (size_t t = 0; t + 2 < out.indices.size(); t += 3)
            best = std::min(best, ptTri(p, out.vertices[out.indices[t]].position, out.vertices[out.indices[t + 1]].position, out.vertices[out.indices[t + 2]].position));
        worst = std::max(worst, best);
    }
    return worst;
}
// edges of the position-welded surface used by one triangle only
static size_t openEdges(const ScratchboxMesh& m) {
    std::map<std::tuple<float, float, float>, uint32_t> id; std::vector<uint32_t> w(m.vertices.size());
    for (size_t i = 0; i < m.vertices.size(); ++i) { auto& p = m.vertices[i].position; w[i] = id.emplace(std::make_tuple(p.x, p.y, p.z), uint32_t(id.size())).first->second; }
    std::map<std::pair<uint32_t, uint32_t>, int> e;
    for (size_t t = 0; t + 2 < m.indices.size(); t += 3) for (int k = 0; k < 3; ++k) {
        uint32_t a = w[m.indices[t + k]], b = w[m.indices[t + (k + 1) % 3]]; if (a == b) continue; e[{std::min(a, b), std::max(a, b)}]++;
    }
    size_t n = 0; for (auto& [k, c] : e) if (c == 1) ++n; return n;
}
int main(int argc, char** argv) {
    ScratchboxMesh in = torus(160, 96);
    meshopt::SimplifyOptions byCount; byCount.targetRatio = 0.1f;
    auto r1 = meshopt::simplify(in, byCount);
    meshopt::SimplifyOptions byError; byError.targetRatio = 0.0f; byError.maxErrorMeters = 0.05f;
    auto r2 = meshopt::simplify(in, byError);
    ScratchboxMesh shuffled = in;
    std::vector<std::array<uint32_t, 3>> tris; for (size_t t = 0; t < in.indices.size(); t += 3) tris.push_back({in.indices[t], in.indices[t + 1], in.indices[t + 2]});
    std::mt19937 rng(7); std::shuffle(tris.begin(), tris.end(), rng);
    shuffled.indices.clear(); for (auto& t : tris) shuffled.addTriangle(t[0], t[1], t[2]);
    float acmrBefore = meshopt::cacheMissRatio(shuffled);
    meshopt::optimizeVertexCache(shuffled);
    float acmrAfter = meshopt::cacheMissRatio(shuffled);
    auto glb = io::GlbWriter::writeGlb(r2.mesh);
    FILE* f = std::fopen(argv[1], "wb"); std::fwrite(glb.data(), 1, glb.size(), f); std::fclose(f);
    std::printf("{\"in\":%zu,\"inOpen\":%zu,\"countTris\":%zu,\"countErr\":%.6f,\"countDev\":%.6f,\"countOpen\":%zu,"
                "\"errTris\":%zu,\"errErr\":%.6f,\"errDev\":%.6f,\"errOpen\":%zu,\"errVerts\":%zu,\"acmrBefore\":%.4f,\"acmrAfter\":%.4f}\n",
        r1.trianglesBefore, openEdges(in), r1.trianglesAfter, r1.estimatedErrorMeters, deviation(in, r1.mesh), openEdges(r1.mesh),
        r2.trianglesAfter, r2.estimatedErrorMeters, deviation(in, r2.mesh), openEdges(r2.mesh), r2.mesh.vertices.size(), acmrBefore, acmrAfter);
    (void)argc;
    return 0;
}
`;

describe('meshoptimizer through scratchbox_meshopt.hpp', () => {
    it('simplifies a real seamed torus to a count and to an error bound, closed, and writes a GLB', async () => {
        const compiler = new NativeCppCompilerService();
        const outDir = path.join(dir, 'meshopt-run');
        const res = await compiler.compileSource(MESHOPT_PROGRAM, { outputDir: outDir, outputBinaryName: 'meshopt_torus', vendored: ['meshoptimizer'] });
        expect(res.compilerOutput).not.toMatch(/error:/);
        expect(res.success).toBe(true);
        const glbPath = path.join(outDir, 'torus.glb');
        const run = await compiler.executeBinary(res.binaryPath!, [glbPath], outDir);
        expect(run.exitCode).toBe(0);
        const m = JSON.parse(run.stdout.trim().split('\n').pop()!);

        expect(m.in).toBe(160 * 96 * 2);
        expect(m.inOpen).toBe(0);
        // the count target: at most a tenth, and not collapsed to nothing
        expect(m.countTris).toBeLessThanOrEqual(m.in / 10);
        expect(m.countTris).toBeGreaterThan(m.in / 20);
        expect(m.countOpen).toBe(0);
        // the error bound: the reported (quadric) error within it; the input surface measured within 1.7x it, the
        // estimate's known gap to a true distance (measured 0.082 m here for a 0.05 m bound)
        expect(m.errErr).toBeLessThanOrEqual(0.05);
        expect(m.errDev).toBeLessThanOrEqual(0.05 * 1.7);
        expect(m.errDev).toBeGreaterThan(0.01);
        expect(m.errTris).toBeLessThan(m.in / 2);
        expect(m.errOpen).toBe(0);
        // and on the count result the measured deviation stays within 1.7x the estimate too
        expect(m.countDev).toBeLessThanOrEqual(m.countErr * 1.7);
        // vertex cache: a shuffled torus's ACMR drops well below 1.5 (optimal ~0.6-0.7)
        expect(m.acmrBefore).toBeGreaterThan(2);
        expect(m.acmrAfter).toBeLessThan(0.8);
        // the fetch optimisation dropped unused vertices
        expect(m.errVerts).toBeLessThan(m.errTris);

        const glb = fs.readFileSync(glbPath);
        expect(glb.subarray(0, 4).toString('latin1')).toBe('glTF');
        expect(glb.readUInt32LE(4)).toBe(2);
        expect(glb.readUInt32LE(8)).toBe(glb.length);
    });
});
