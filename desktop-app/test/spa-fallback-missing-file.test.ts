/**
 * With a built renderer, the server answers page routes with its index.html (the SPA fallback). A file it does not
 * have (a saved chat's model built in another checkout, a demo video never hydrated) must answer 404, not that page
 * with 200: the viewport would otherwise parse the HTML as glTF and report `Unexpected token '<'` after five retries.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import http from 'http';
import { createStandaloneServer, isFileRequestPath } from '../server/app';

const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0, 24, 0, 0, 0]), Buffer.alloc(12, 7)]);
const PAGE = '<!DOCTYPE html><html><body><div id="root"></div></body></html>';

const originalCwd = process.cwd();
const originalAssetStore = process.env.SCRATCHBOX_ASSET_STORE;
let server: http.Server | undefined;
let tmp: string | undefined;

afterEach(async () => {
    process.chdir(originalCwd);
    if (originalAssetStore === undefined) delete process.env.SCRATCHBOX_ASSET_STORE;
    else process.env.SCRATCHBOX_ASSET_STORE = originalAssetStore;
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
});

/** A checkout with a built renderer (dist/index.html) and one model in public/models, served as the dev script does. */
async function startCheckout(): Promise<string> {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-spa-fallback-'));
    const cwd = path.join(tmp, 'desktop-app');
    const staticDir = path.join(cwd, 'dist');
    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(path.join(staticDir, 'index.html'), PAGE);
    fs.mkdirSync(path.join(tmp, 'public', 'models'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'public', 'models', 'present.glb'), GLB);
    // only this checkout's files: the user's asset store must not answer for (or be written by) the test
    process.env.SCRATCHBOX_ASSET_STORE = '0';
    process.chdir(cwd);
    const app = createStandaloneServer({ port: 0, toolsPort: 3999, staticDir });
    server = http.createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const get = (url: string) => fetch(url, { headers: { Connection: 'close' } });

describe('SPA fallback', () => {
    it('answers a missing model, video or demo file with 404, never the app page', async () => {
        const base = await startCheckout();
        // names no checkout holds (the server also serves the repository's own public/ directory)
        for (const missing of [
            '/models/sb_test_missing_church_iso_tiles_52c85820.glb',
            '/models/sb_test_missing_church_iso_tiles_52c85820.order.json',
            '/videos/sb_test_missing_clip.mp4',
            '/sb_test_missing_demo_page.html'
        ]) {
            const res = await get(`${base}${missing}`);
            const body = await res.text();
            expect(res.status, missing).toBe(404);
            expect(res.headers.get('content-type'), missing).toMatch(/application\/json/);
            expect(body).not.toContain('<!DOCTYPE');
            expect(JSON.parse(body)).toEqual({ error: 'not_found', message: `${missing} is not on this machine` });
        }
    });

    it('still serves files that are here, and the app page for page routes', async () => {
        const base = await startCheckout();
        const model = await get(`${base}/models/present.glb`);
        const bytes = Buffer.from(await model.arrayBuffer());
        expect(model.status).toBe(200);
        expect(bytes.equals(GLB)).toBe(true);

        for (const route of ['/', '/chat/session-chat-1793213112459', '/settings']) {
            const page = await get(`${base}${route}`);
            const html = await page.text();
            expect(page.status, route).toBe(200);
            expect(html, route).toBe(PAGE);
        }
    });
});

describe('isFileRequestPath', () => {
    it('names served files, by prefix or by extension, and nothing else', () => {
        expect(isFileRequestPath('/models/x.glb')).toBe(true);
        expect(isFileRequestPath('/models/no_extension')).toBe(true);
        expect(isFileRequestPath('/renders/a/b.png')).toBe(true);
        expect(isFileRequestPath('/videos/clip.mp4')).toBe(true);
        expect(isFileRequestPath('/forest_3d_viewer.html')).toBe(true);
        expect(isFileRequestPath('/')).toBe(false);
        expect(isFileRequestPath('/chat/session-chat-1793213112459')).toBe(false);
        expect(isFileRequestPath('/settings')).toBe(false);
    });
});
