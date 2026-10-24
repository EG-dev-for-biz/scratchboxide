import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileNativeCached, defaultNativeFlags } from '../src/node/3d-engine/native-build-cache';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { MASK_NO, MASK_YES } from '../src/node/3d-engine/staged-location/facade-material-evidence';
import { projectMaskedViewsToUv, type PinholeView } from '../src/node/spatial/specular-material-projection';

// A single wall quad, z = 0, x in [-2, 2], y in [0, 4], facing +z, with UV = ((x + 2) / 4, y / 4): a plain atlas, not a
// chart-plane trick, so the mesh carries nothing of the staged-location pipeline.
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

const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-specular-'));
let wallGlb: string;

// A camera at (0, 2, 5) looking down -z at the wall (right = +x, up = +y): world x = D * (px - cx) / fx,
// world y = eyeY + D * (py - cy) / fy, where D = eye.z - wall.z = 5. width = height = raysPerAxis so the mask
// aligns 1:1 with the ray grid, and the window's pixels can be computed analytically rather than by eye.
const D = 5, EYE_Y = 2, SIZE = 256, FX = 256, FY = 256, CX = 128, CY = 128;
function windowMask(present: boolean): Uint8Array {
    const m = new Uint8Array(SIZE * SIZE).fill(MASK_NO);
    if (!present) return m;
    for (let py = 0; py < SIZE; py++) {
        const wy = EYE_Y + D * (py - CY) / FY;
        for (let px = 0; px < SIZE; px++) {
            const wx = D * (px - CX) / FX;
            // the window: world x in [-0.5, 0.5], y in [1.5, 2.5] -> uv x in [0.375, 0.625], uv y in [0.375, 0.625]
            if (wx >= -0.5 && wx <= 0.5 && wy >= 1.5 && wy <= 2.5) m[py * SIZE + px] = MASK_YES;
        }
    }
    return m;
}

function view(mask: Uint8Array): PinholeView {
    return { eye: [0, EYE_Y, D], right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, -1], fx: FX, fy: FY, cx: CX, cy: CY, width: SIZE, height: SIZE, mask };
}

describe('projectMaskedViewsToUv: the two-views-must-agree floor, generalized to any mesh via raycasting', () => {
    beforeAll(async () => {
        const compiler = NativeCppCompilerService.getInstance();
        const result = await compileNativeCached({ sourceCode: WRITE_WALL_SOURCE, includeDirs: [compiler.getSdkIncludePath()], flags: defaultNativeFlags(), libs: ['-lz'], name: 'specular_test_wall' });
        wallGlb = path.join(SCRATCH_DIR, 'wall.glb');
        const { execFileSync } = await import('node:child_process');
        execFileSync(result.binaryPath, [wallGlb], { timeout: 60_000 });
    }, 60_000);

    afterAll(() => fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }));

    it('accepts the window region when 3 of 3 views agree, at its real UV location', async () => {
        const views = [view(windowMask(true)), view(windowMask(true)), view(windowMask(true))];
        const r = await projectMaskedViewsToUv(wallGlb, views, { raysPerAxis: 64, gridSize: 128 });
        expect(r.cellsAccepted).toBeGreaterThan(0);
        expect(r.regions.length).toBeGreaterThan(0);
        const biggest = r.regions[0];
        expect(biggest.agreeingViews).toBe(3);
        const [x0, y0, x1, y1] = biggest.bounds;
        const toUv = (c: number, lo: number, hi: number) => lo + (c / r.gridSize) * (hi - lo);
        const uLo = toUv(x0, r.uvMin[0], r.uvMax[0]), uHi = toUv(x1, r.uvMin[0], r.uvMax[0]);
        const vLo = toUv(y0, r.uvMin[1], r.uvMax[1]), vHi = toUv(y1, r.uvMin[1], r.uvMax[1]);
        expect(uLo).toBeGreaterThan(0.3); expect(uHi).toBeLessThan(0.7);
        expect(vLo).toBeGreaterThan(0.3); expect(vHi).toBeLessThan(0.7);
    }, 60_000);

    it('rejects the window when only 1 of 3 views marks it (below the agreement floor)', async () => {
        const views = [view(windowMask(true)), view(windowMask(false)), view(windowMask(false))];
        const r = await projectMaskedViewsToUv(wallGlb, views, { raysPerAxis: 64, gridSize: 128 });
        expect(r.cellsAccepted).toBe(0);
        expect(r.regions).toHaveLength(0);
    }, 60_000);
});
