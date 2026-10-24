import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileNativeCached, defaultNativeFlags } from '../src/node/3d-engine/native-build-cache';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { MASK_NO, MASK_UNREAD, MASK_YES, type SegmentImage } from '../src/node/3d-engine/staged-location/facade-material-evidence';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { createSpecularMaterialsHandler } from '../src/node/gemini/tools/specular-material-tools';
import type { ToolContext } from '../src/node/gemini/tools/types';

// A single wall quad, z = 0, x in [-2, 2], y in [0, 4]: the same single-UV-island mesh specular-material-projection's
// own tests use, so referenceViews can be checked with exact analytic cameras (no risk of a box's per-face UV aliasing
// creating accidental agreement or contradiction between unrelated faces).
const WRITE_WALL_SOURCE = `
#include "scratchbox_gltf_scene.hpp"
#include <cstdio>
using namespace scratchbox;
using geometry::ScratchboxMesh;
using geometry::Vertex;
using math::Vec3;
using math::Vec2;
int main(int argc, char** argv) {
    if (argc < 2) { std::fprintf(stderr, "usage: outGlb\\n"); return 1; }
    ScratchboxMesh mesh("wall");
    mesh.addVertex(Vertex(Vec3(-2, 0, 0), Vec3(0, 0, 1), Vec2(0, 0)));
    mesh.addVertex(Vertex(Vec3(2, 0, 0), Vec3(0, 0, 1), Vec2(1, 0)));
    mesh.addVertex(Vertex(Vec3(2, 4, 0), Vec3(0, 0, 1), Vec2(1, 1)));
    mesh.addVertex(Vertex(Vec3(-2, 4, 0), Vec3(0, 0, 1), Vec2(0, 1)));
    mesh.indices = {0, 1, 2, 0, 2, 3};
    if (!io::GlbWriter::writeToFile(mesh, argv[1])) { std::fprintf(stderr, "write failed\\n"); return 1; }
    std::printf("ok\\n");
    return 0;
}
`;

// A camera at (0, 2, 5) looking down -z at the wall: world x = D * (px - cx) / fx, world y = eyeY - D * (py - cy) / fy
// (row 0 is the image's top). D = 5, width = height = 256 so the mask aligns 1:1 with pixels.
const D = 5, EYE_Y = 2, SIZE = 256, FX = 256, FY = 256, CX = 128, CY = 128;
function windowMask(): Uint8Array {
    const m = new Uint8Array(SIZE * SIZE).fill(MASK_NO);
    for (let py = 0; py < SIZE; py++) {
        const wy = EYE_Y - D * (py - CY) / FY;
        for (let px = 0; px < SIZE; px++) {
            const wx = D * (px - CX) / FX;
            if (wx >= -0.5 && wx <= 0.5 && wy >= 1.5 && wy <= 2.5) m[py * SIZE + px] = MASK_YES;
        }
    }
    return m;
}
const blankMask = () => new Uint8Array(SIZE * SIZE).fill(MASK_NO);
const unreadMask = () => new Uint8Array(SIZE * SIZE).fill(MASK_UNREAD);
const WALL_CAMERA = { eye: [0, EYE_Y, D] as [number, number, number], right: [1, 0, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number], fwd: [0, 0, -1] as [number, number, number], fx: FX, fy: FY, cx: CX, cy: CY };

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

const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-specular-tool-'));
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

const neverFoundSegmenter: SegmentImage = async (_png, width, height) => ({ mask: new Uint8Array(width * height).fill(MASK_NO) });

const fakeCtx = {} as ToolContext;
let wallGlb: string;
let blankPng: string;

describe('infer_specular_materials: the tool shell end to end, with a synthetic segmenter (no vision model, no billing)', () => {
    beforeAll(async () => {
        const compiler = NativeCppCompilerService.getInstance();
        const result = await compileNativeCached({ sourceCode: WRITE_BLUE_BOX_SOURCE, includeDirs: [compiler.getSdkIncludePath()], flags: defaultNativeFlags(), libs: ['-lz'], name: 'specular_tool_blue_box' });
        blueBoxGlb = path.join(SCRATCH_DIR, 'blue_box.glb');
        const { execFileSync } = await import('node:child_process');
        execFileSync(result.binaryPath, [blueBoxGlb], { timeout: 60_000 });

        const wallResult = await compileNativeCached({ sourceCode: WRITE_WALL_SOURCE, includeDirs: [compiler.getSdkIncludePath()], flags: defaultNativeFlags(), libs: ['-lz'], name: 'specular_tool_wall' });
        wallGlb = path.join(SCRATCH_DIR, 'wall.glb');
        execFileSync(wallResult.binaryPath, [wallGlb], { timeout: 60_000 });

        blankPng = path.join(SCRATCH_DIR, 'blank.png');
        fs.writeFileSync(blankPng, encodePng(SIZE, SIZE, new Uint8Array(SIZE * SIZE * 4).fill(128), 4));
    }, 60_000);

    afterAll(() => fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }));

    it('self-renders, finds the centre region, bakes it, and labels the result generated (not measured)', async () => {
        const handler = createSpecularMaterialsHandler({ segment: centerSquareSegmenter(0.3) });
        const outcome = await handler({ glbPath: blueBoxGlb, selfRenderViews: 6, outputGlbPath: path.join(SCRATCH_DIR, 'tool_out.glb') }, fakeCtx);
        expect(outcome.status).toBe('completed');
        const payload = outcome.resultPayload as Record<string, unknown>;
        expect(payload.tier).toBe('self-render');
        expect((payload.regions as unknown[]).length).toBeGreaterThan(0);
        expect((payload.provenance as { label: string }).label).toBe('generated');
        expect((payload.provenance as { confidence: number }).confidence).toBeGreaterThan(0);
        expect((payload.provenance as { confidence: number }).confidence).toBeLessThan(1);
        const baked = payload.baked as { glbPath: string; acceptedTexels: number } | undefined;
        expect(baked).toBeDefined();
        expect(fs.existsSync(baked!.glbPath)).toBe(true);
        expect(baked!.acceptedTexels).toBeGreaterThan(0);
    }, 120_000);

    it('reports no regions, honestly, when nothing is ever found — no false positives from an empty segmenter', async () => {
        const handler = createSpecularMaterialsHandler({ segment: neverFoundSegmenter });
        const outcome = await handler({ glbPath: blueBoxGlb, selfRenderViews: 4 }, fakeCtx);
        const payload = outcome.resultPayload as Record<string, unknown>;
        expect(payload.cellsAccepted).toBe(0);
        expect((payload.regions as unknown[]).length).toBe(0);
        expect(payload.baked).toBeUndefined();
    }, 120_000);

    it('bake: false reports regions without writing a new GLB', async () => {
        const handler = createSpecularMaterialsHandler({ segment: centerSquareSegmenter(0.3) });
        const outcome = await handler({ glbPath: blueBoxGlb, selfRenderViews: 6, bake: false }, fakeCtx);
        const payload = outcome.resultPayload as Record<string, unknown>;
        expect((payload.regions as unknown[]).length).toBeGreaterThan(0);
        expect(payload.baked).toBeUndefined();
        expect(payload.bakeError).toBeUndefined();
    }, 120_000);

    it('the posed (referenceViews) tier: 3 identical analytic cameras, only 1 marking the window, is rejected at the default floor', async () => {
        let calls = 0;
        const oneOfThreeSegmenter: SegmentImage = async () => { calls++; return { mask: calls === 1 ? windowMask() : blankMask() }; };
        const handler = createSpecularMaterialsHandler({ segment: oneOfThreeSegmenter });
        const referenceViews = [WALL_CAMERA, WALL_CAMERA, WALL_CAMERA].map(c => ({ imagePath: blankPng, ...c }));
        const outcome = await handler({ glbPath: wallGlb, referenceViews, bake: false }, fakeCtx);
        const payload = outcome.resultPayload as Record<string, unknown>;
        expect(payload.tier).toBe('posed');
        expect(payload.cellsAccepted).toBe(0);
        expect((payload.regions as unknown[]).length).toBe(0);
    }, 60_000);

    it('allowSingleViewFallback accepts a single view\'s read once the floor finds nothing, when nothing else contradicts it, at low confidence', async () => {
        // the other two views have no opinion here (unread), not an explicit "no": a real fallback case, not a
        // contradiction one, since even minAgreeingViews:1 still requires more yes votes than no at that cell.
        let calls = 0;
        const oneUnreadSegmenter: SegmentImage = async () => { calls++; return { mask: calls === 1 ? windowMask() : unreadMask() }; };
        const handler = createSpecularMaterialsHandler({ segment: oneUnreadSegmenter });
        const referenceViews = [WALL_CAMERA, WALL_CAMERA, WALL_CAMERA].map(c => ({ imagePath: blankPng, ...c }));
        const outcome = await handler({ glbPath: wallGlb, referenceViews, bake: false, allowSingleViewFallback: true }, fakeCtx);
        const payload = outcome.resultPayload as Record<string, unknown>;
        expect(payload.tier).toBe('single-view-fallback');
        expect((payload.regions as unknown[]).length).toBeGreaterThan(0);
        expect((payload.provenance as { confidence: number }).confidence).toBeLessThan(0.4);
    }, 60_000);
});
