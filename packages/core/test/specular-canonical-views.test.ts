import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileNativeCached, defaultNativeFlags } from '../src/node/3d-engine/native-build-cache';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { decodePng } from '../src/node/texture-processing';
import { renderCanonicalViews } from '../src/node/spatial/specular-canonical-views';

// A bare red box, no scene, no geo anchor: the "any instance" case this is meant for.
const WRITE_RED_BOX_SOURCE = `
#include "scratchbox_gltf_scene.hpp"
#include <cstdio>
using namespace scratchbox;
using geometry::ScratchboxMesh;
using math::Vec3;
using math::Vec4;
int main(int argc, char** argv) {
    if (argc < 2) { std::fprintf(stderr, "usage: outGlb\\n"); return 1; }
    ScratchboxMesh mesh = ScratchboxMesh::createBox(Vec3(2, 2, 2), Vec4(1, 0, 0, 1));
    mesh.material.baseColorFactor = Vec4(1, 0, 0, 1);
    mesh.material.metallicFactor = 0.0f;
    mesh.material.roughnessFactor = 0.9f;
    if (!io::GlbWriter::writeToFile(mesh, argv[1])) { std::fprintf(stderr, "write failed\\n"); return 1; }
    std::printf("ok\\n");
    return 0;
}
`;

const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-canonical-'));
let redBoxGlb: string;

describe('renderCanonicalViews: self-render evidence on a bare GLB, no scene or geo anchor needed', () => {
    beforeAll(async () => {
        const compiler = NativeCppCompilerService.getInstance();
        const result = await compileNativeCached({ sourceCode: WRITE_RED_BOX_SOURCE, includeDirs: [compiler.getSdkIncludePath()], flags: defaultNativeFlags(), libs: ['-lz'], name: 'specular_test_red_box' });
        redBoxGlb = path.join(SCRATCH_DIR, 'red_box.glb');
        const { execFileSync } = await import('node:child_process');
        execFileSync(result.binaryPath, [redBoxGlb], { timeout: 60_000 });
    }, 60_000);

    afterAll(() => fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }));

    it('every one of the orbit views actually frames the box (its own colour dominates each render), not just one angle', async () => {
        const views = await renderCanonicalViews(redBoxGlb, { count: 4, width: 128, height: 128 });
        expect(views).toHaveLength(4);
        for (const v of views) {
            expect(v.png.length).toBeGreaterThan(0);
            const decoded = decodePng(v.png);
            expect(decoded.width).toBe(128);
            expect(decoded.height).toBe(128);
            let rSum = 0, gSum = 0, bSum = 0;
            const n = decoded.rgba.length / 4;
            for (let i = 0; i < n; i++) { rSum += decoded.rgba[i * 4]; gSum += decoded.rgba[i * 4 + 1]; bSum += decoded.rgba[i * 4 + 2]; }
            const rMean = rSum / n, gMean = gSum / n, bMean = bSum / n;
            // the box's own red dominates the frame: nothing in this render is bright red except the box
            expect(rMean).toBeGreaterThan(gMean + 20);
            expect(rMean).toBeGreaterThan(bMean + 20);
        }
    }, 120_000);
});
