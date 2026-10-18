/**
 * scratchbox_pbr_manifold.hpp: the named example descriptors are a data table looked up by id, compiled with the
 * real clang++. Ids do not wrap (52 used to come back as Roman Travertine) and an unknown id throws.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags } from '../src/node/3d-engine/native-build-cache';

const INCLUDE = path.resolve(__dirname, '../src/native/3d-engine/include');

const SOURCE = String.raw`
#include "scratchbox_pbr_manifold.hpp"
#include <cstdio>
using namespace scratchbox::pbr_manifold;
int main() {
    std::printf("examples %zu\n", manifoldExamples().size());
    auto t = getAnchorManifoldPoint(2);
    std::printf("travertine %.2f %.2f %.2f %.2f\n", t.anisotropyStrength, t.fissureScale, t.fissureDepth, t.roughnessBaseline);
    auto c = getAnchorManifoldPoint(5);
    std::printf("catalog5 %.3f %.3f\n", c.microPorosity, c.roughnessBaseline * 0.45f);
    try { getAnchorManifoldPoint(52); std::printf("wrapped\n"); } catch (const std::out_of_range& e) { std::printf("threw %s\n", e.what()); }
    return 0;
}
`;

describe('scratchbox_pbr_manifold.hpp example descriptors (native)', () => {
    it('are looked up by id from a table of 50, never wrapped or substituted', async () => {
        const built = await compileNativeCached({ sourceCode: SOURCE, includeDirs: [INCLUDE], flags: defaultNativeFlags(['-pthread']), name: 'pbr_manifold_examples' });
        const out = execFileSync(built.binaryPath, { encoding: 'utf8' });
        expect(out).toMatch(/examples 50/);
        expect(out).toMatch(/travertine 0\.65 6\.00 0\.45 0\.48/);
        const [, micro, expected] = /catalog5 ([\d.]+) ([\d.]+)/.exec(out)!;
        expect(micro).toBe(expected);
        expect(out).toMatch(/threw getAnchorManifoldPoint: no example descriptor with id 52/);
        expect(out).not.toMatch(/wrapped/);
    }, 120_000);
});
