/**
 * Saved 3D scenes drop the base64 copy of a generator's model when the model is a file in the Python runner's
 * output directory (build/3d-python), and the viewport loads it from /build/3d-python/ on reload. The runner
 * creates that directory on its first run, which can be after the server started (or after a clean), so the
 * route must not depend on the directory existing at startup.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import http from 'http';
import { createStandaloneServer } from '../server/app';

/** The 12-byte header of a binary glTF, plus a body, as the runner writes it. */
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0, 24, 0, 0, 0]), Buffer.alloc(12, 7)]);

const originalCwd = process.cwd();
let server: http.Server | undefined;
let tmp: string | undefined;

afterEach(async () => {
    process.chdir(originalCwd);
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
});

/** Starts the server with `cwd` as its working directory, as `npm --prefix desktop-app` does. */
async function startIn(cwd: string): Promise<string> {
    process.chdir(cwd);
    const app = createStandaloneServer({ port: 0, toolsPort: 3999 });
    server = http.createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const get = (url: string) => fetch(url, { headers: { Connection: 'close' } });

describe('/build/3d-python', () => {
    for (const [label, outputDir] of [
        ['the working directory', (root: string) => path.join(root, 'desktop-app', 'build', '3d-python')],
        ['the repository root above it', (root: string) => path.join(root, 'build', '3d-python')]
    ] as const) {
        it(`serves a model written to ${label} after the server started`, async () => {
            tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-build-static-'));
            const cwd = path.join(tmp, 'desktop-app');
            fs.mkdirSync(cwd, { recursive: true });
            const base = await startIn(cwd);
            const dir = outputDir(tmp);
            expect(fs.existsSync(dir)).toBe(false);

            const missing = await get(`${base}/build/3d-python/scene_late.glb`);
            expect(missing.status).toBe(404);

            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'scene_late.glb'), GLB);

            const res = await get(`${base}/build/3d-python/scene_late.glb`);
            expect(res.status).toBe(200);
            const body = Buffer.from(await res.arrayBuffer());
            expect(body.subarray(0, 4).toString('latin1')).toBe('glTF');
            expect(body.equals(GLB)).toBe(true);
        });
    }

    it('serves the model again after the directory is cleaned and rebuilt', async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-build-static-'));
        const cwd = path.join(tmp, 'desktop-app');
        const dir = path.join(cwd, 'build', '3d-python');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'scene_1.glb'), GLB);
        const base = await startIn(cwd);
        expect((await get(`${base}/build/3d-python/scene_1.glb`)).status).toBe(200);

        fs.rmSync(path.join(cwd, 'build'), { recursive: true, force: true });
        expect((await get(`${base}/build/3d-python/scene_1.glb`)).status).toBe(404);

        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'scene_1.glb'), GLB);
        expect((await get(`${base}/build/3d-python/scene_1.glb`)).status).toBe(200);
    });
});
