import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileNativeCached, defaultNativeFlags } from '../src/node/3d-engine/native-build-cache';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { bvhQueryHandlers } from '../src/node/gemini/tools/bvh-query-tools';
import type { ToolContext } from '../src/node/gemini/tools/types';

// A single quad (two triangles) in the XZ plane, Y up, with UVs spanning its own corners (not 0..1 of
// some atlas) so a wrong texCoord (e.g. barycentric u/v instead of the mesh's own UV) is caught.
const WRITE_QUAD_SOURCE = `
#include "scratchbox_gltf_scene.hpp"
#include <cstdio>
using namespace scratchbox;
using geometry::ScratchboxMesh;
using geometry::Vertex;
using math::Vec3;
using math::Vec2;
int main(int argc, char** argv) {
    if (argc < 2) { std::fprintf(stderr, "usage: outGlb\\n"); return 1; }
    ScratchboxMesh mesh("quad");
    // corners: (-1,0,-1)->uv(0,0), (1,0,-1)->uv(2,0), (1,0,1)->uv(2,2), (-1,0,1)->uv(0,2)
    mesh.addVertex(Vertex(Vec3(-1, 0, -1), Vec3(0, 1, 0), Vec2(0, 0)));
    mesh.addVertex(Vertex(Vec3(1, 0, -1), Vec3(0, 1, 0), Vec2(2, 0)));
    mesh.addVertex(Vertex(Vec3(1, 0, 1), Vec3(0, 1, 0), Vec2(2, 2)));
    mesh.addVertex(Vertex(Vec3(-1, 0, 1), Vec3(0, 1, 0), Vec2(0, 2)));
    mesh.indices = {0, 1, 2, 0, 2, 3};
    if (!io::GlbWriter::writeToFile(mesh, argv[1])) { std::fprintf(stderr, "write failed\\n"); return 1; }
    std::printf("ok\\n");
    return 0;
}
`;

const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-bvh-uv-'));
const compiler = NativeCppCompilerService.getInstance();
const FLAGS = defaultNativeFlags();

async function compileAndRun(name: string, source: string, args: string[]): Promise<string> {
    const result = await compileNativeCached({ sourceCode: source, includeDirs: [compiler.getSdkIncludePath()], flags: FLAGS, libs: ['-lz'], name });
    const { execFile } = await import('node:child_process');
    return new Promise((resolve, reject) => {
        execFile(result.binaryPath, args, { timeout: 60_000 }, (err, stdout, stderr) => {
            if (err) reject(Object.assign(err, { stderr })); else resolve(stdout);
        });
    });
}

describe('mesh_bvh_raycast: the hit carries the mesh\'s own texture UV, not just barycentric weights', () => {
    afterAll(() => fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }));

    it('a ray straight down at the quad\'s centre reads back its own UV centre, interpolated from the corners’ UVs', async () => {
        const glbPath = path.join(SCRATCH_DIR, 'quad.glb');
        await compileAndRun('bvh_uv_test_quad', WRITE_QUAD_SOURCE, [glbPath]);
        expect(fs.existsSync(glbPath)).toBe(true);

        const [, handler] = bvhQueryHandlers.find(([decl]) => decl.name === 'mesh_bvh_raycast')!;
        const outcome = await handler({
            glbPath,
            rays: [
                // straight down through the quad's centre (0,0,0): should land at uv (1,1), the mean of the corners
                { originX: 0, originY: 5, originZ: 0, dirX: 0, dirY: -1, dirZ: 0 },
                // straight down through the corner at (-1,0,-1): should land at uv (0,0)
                { originX: -1, originY: 5, originZ: -1, dirX: 0, dirY: -1, dirZ: 0 },
                // a ray that misses the quad entirely
                { originX: 10, originY: 5, originZ: 10, dirX: 0, dirY: -1, dirZ: 0 }
            ]
        }, {} as ToolContext);

        expect(outcome.status).toBe('completed');
        const hits = (outcome.resultPayload as { hits: Array<{ hit: boolean; texCoord?: [number, number] }> }).hits;
        expect(hits).toHaveLength(3);

        expect(hits[0].hit).toBe(true);
        expect(hits[0].texCoord![0]).toBeCloseTo(1, 4);
        expect(hits[0].texCoord![1]).toBeCloseTo(1, 4);

        expect(hits[1].hit).toBe(true);
        expect(hits[1].texCoord![0]).toBeCloseTo(0, 4);
        expect(hits[1].texCoord![1]).toBeCloseTo(0, 4);

        expect(hits[2].hit).toBe(false);
    }, 60_000);
});
