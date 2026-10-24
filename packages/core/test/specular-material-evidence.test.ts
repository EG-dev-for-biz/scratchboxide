import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileNativeCached, defaultNativeFlags } from '../src/node/3d-engine/native-build-cache';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { MASK_NO, MASK_YES, type SegmentImage } from '../src/node/3d-engine/staged-location/facade-material-evidence';
import { gatherSelfRenderEvidence } from '../src/node/spatial/specular-material-evidence';
import { projectMaskedViewsToUv } from '../src/node/spatial/specular-material-projection';

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

const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-specular-evidence-'));
let redBoxGlb: string;

/** Marks the image's own central square yes, the margin around it no; no vision model, no pixel content read — a
 *  deterministic stand-in for a real segmenter, so this test proves the render -> segment -> raycast -> vote wiring,
 *  not vision quality (facade-materials.test.ts already proves the agreement floor itself with synthetic masks).
 *  Every orbit camera is aimed at the mesh's own centre, so its centre is guaranteed to land on the mesh regardless
 *  of exact framing, unlike a band picked by image position alone. */
function centerSquareSegmenter(shareOfFrame: number): SegmentImage {
    return async (_png, width, height) => {
        const m = new Uint8Array(width * height).fill(MASK_NO);
        const x0 = Math.floor(width * (1 - shareOfFrame) / 2), x1 = width - x0;
        const y0 = Math.floor(height * (1 - shareOfFrame) / 2), y1 = height - y0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * width + x] = MASK_YES;
        return { mask: m };
    };
}

const neverFoundSegmenter: SegmentImage = async (_png, width, height) => ({ mask: new Uint8Array(width * height).fill(MASK_NO) });

describe('gatherSelfRenderEvidence + projectMaskedViewsToUv: the whole self-render path, wired end to end', () => {
    beforeAll(async () => {
        const compiler = NativeCppCompilerService.getInstance();
        const result = await compileNativeCached({ sourceCode: WRITE_RED_BOX_SOURCE, includeDirs: [compiler.getSdkIncludePath()], flags: defaultNativeFlags(), libs: ['-lz'], name: 'specular_evidence_red_box' });
        redBoxGlb = path.join(SCRATCH_DIR, 'red_box.glb');
        const { execFileSync } = await import('node:child_process');
        execFileSync(result.binaryPath, [redBoxGlb], { timeout: 60_000 });
    }, 60_000);

    afterAll(() => fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }));

    it('a feature near the centre of every orbit view (every camera aims at the mesh\'s own centre) is found and accepted by real multi-view agreement', async () => {
        const views = await gatherSelfRenderEvidence(redBoxGlb, centerSquareSegmenter(0.3), { count: 6, width: 192, height: 192 });
        expect(views).toHaveLength(6);
        expect(views.some(v => v.mask.some(m => m === MASK_YES))).toBe(true);

        const r = await projectMaskedViewsToUv(redBoxGlb, views, { raysPerAxis: 48, gridSize: 96, minAgreeingViews: 2 });
        expect(r.cellsAccepted).toBeGreaterThan(0);
        expect(r.regions.length).toBeGreaterThan(0);
        expect(r.regions[0].agreeingViews).toBeGreaterThanOrEqual(2);
    }, 120_000);

    it('a segmenter that never finds the target yields no accepted cells (no false positives from an all-negative signal)', async () => {
        const views = await gatherSelfRenderEvidence(redBoxGlb, neverFoundSegmenter, { count: 4, width: 128, height: 128 });
        expect(views.every(v => v.mask.every(m => m === MASK_NO))).toBe(true);

        const r = await projectMaskedViewsToUv(redBoxGlb, views, { raysPerAxis: 32, gridSize: 64 });
        expect(r.cellsAccepted).toBe(0);
        expect(r.regions).toHaveLength(0);
    }, 120_000);
});
