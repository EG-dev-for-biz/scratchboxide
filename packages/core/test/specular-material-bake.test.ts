import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileNativeCached, defaultNativeFlags } from '../src/node/3d-engine/native-build-cache';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { MASK_NO, type SegmentImage } from '../src/node/3d-engine/staged-location/facade-material-evidence';
import { gatherSelfRenderEvidence } from '../src/node/spatial/specular-material-evidence';
import { projectMaskedViewsToUv } from '../src/node/spatial/specular-material-projection';
import { bakeSpecularMaterials } from '../src/node/spatial/specular-material-bake';

// A blue box with its own material (metallicFactor 0.2, roughnessFactor 0.8), so baking can be checked against a
// real, non-default starting material, not an untouched one.
const WRITE_BLUE_BOX_SOURCE = `
#include "scratchbox_gltf_scene.hpp"
#include <cstdio>
using namespace scratchbox;
using geometry::ScratchboxMesh;
using math::Vec3;
using math::Vec4;
int main(int argc, char** argv) {
    if (argc < 2) { std::fprintf(stderr, "usage: outGlb\\n"); return 1; }
    ScratchboxMesh mesh = ScratchboxMesh::createBox(Vec3(2, 2, 2), Vec4(0, 0, 1, 1));
    mesh.material.baseColorFactor = Vec4(0, 0, 1, 1);
    mesh.material.metallicFactor = 0.2f;
    mesh.material.roughnessFactor = 0.8f;
    if (!io::GlbWriter::writeToFile(mesh, argv[1])) { std::fprintf(stderr, "write failed\\n"); return 1; }
    std::printf("ok\\n");
    return 0;
}
`;

const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-specular-bake-'));
let blueBoxGlb: string;

function centerSquareSegmenter(shareOfFrame: number): SegmentImage {
    return async (_png, width, height) => {
        const m = new Uint8Array(width * height).fill(MASK_NO);
        const x0 = Math.floor(width * (1 - shareOfFrame) / 2), x1 = width - x0;
        const y0 = Math.floor(height * (1 - shareOfFrame) / 2), y1 = height - y0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * width + x] = 255;
        return { mask: m };
    };
}

describe('bakeSpecularMaterials: the vote grid written back into the mesh\'s own material, round-tripped', () => {
    beforeAll(async () => {
        const compiler = NativeCppCompilerService.getInstance();
        const result = await compileNativeCached({ sourceCode: WRITE_BLUE_BOX_SOURCE, includeDirs: [compiler.getSdkIncludePath()], flags: defaultNativeFlags(), libs: ['-lz'], name: 'specular_bake_blue_box' });
        blueBoxGlb = path.join(SCRATCH_DIR, 'blue_box.glb');
        const { execFileSync } = await import('node:child_process');
        execFileSync(result.binaryPath, [blueBoxGlb], { timeout: 60_000 });
    }, 60_000);

    afterAll(() => fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }));

    it('writes a metallicRoughness texture that actually reads back from the output file', async () => {
        const views = await gatherSelfRenderEvidence(blueBoxGlb, centerSquareSegmenter(0.3), { count: 6, width: 160, height: 160 });
        const projection = await projectMaskedViewsToUv(blueBoxGlb, views, { raysPerAxis: 40, gridSize: 64 });
        expect(projection.cellsAccepted).toBeGreaterThan(0);

        const outputGlb = path.join(SCRATCH_DIR, 'blue_box_glass.glb');
        const baked = await bakeSpecularMaterials(blueBoxGlb, projection, outputGlb, { textureSize: 256 });

        expect(fs.existsSync(outputGlb)).toBe(true);
        expect(baked.vertices).toBeGreaterThan(0);
        expect(baked.triangles).toBeGreaterThan(0);
        expect(baked.hadBaseColorTexture).toBe(false); // the source box has only a baseColorFactor, no texture
        expect(baked.acceptedTexels).toBeGreaterThan(0);
        expect(baked.acceptedTexels).toBeLessThan(baked.totalTexels);
        // the independent re-read inside the native tool, not just a successful write
        expect(baked.hasMetallicRoughnessTextureAfter).toBe(true);
        expect(baked.materialsAfter).toBe(1);
        expect(baked.imagesAfter).toBeGreaterThanOrEqual(1);
    }, 120_000);

    it('throws rather than writing a silent partial or empty output when the input cannot be read as a GLB', async () => {
        const fakeResult = { gridSize: 4, uvMin: [0, 0] as [number, number], uvMax: [1, 1] as [number, number], votes: new Uint8Array(16), cellsSampled: 0, cellsAccepted: 0, regions: [] };
        const notAGlb = path.join(SCRATCH_DIR, 'not_a_glb.glb');
        fs.writeFileSync(notAGlb, Buffer.from('this is not glTF binary data'));
        await expect(bakeSpecularMaterials(notAGlb, fakeResult, path.join(SCRATCH_DIR, 'out2.glb'))).rejects.toThrow();
    }, 60_000);
});
