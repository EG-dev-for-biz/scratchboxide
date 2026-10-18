import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import bodyParser from 'body-parser';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createTileCleanupRouter } from '../server/routes/spatialRoutes';
import { PhotorealTileCleanupService } from '../../packages/core/src/node';

const INPUT_GLB = path.resolve(__dirname, '../../deploy/cloud-run/spatial-separator/assets/temple_venus_roma_sb_archi.glb');

describe('/api/3d/tiles cleanup routes clean the tile in the request', () => {
    let server: Server;
    let base: string;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-tile-route-'));

    beforeAll(async () => {
        fs.copyFileSync(INPUT_GLB, path.join(root, 'tile.glb'));
        const app = express();
        app.use(bodyParser.json({ limit: '50mb' }));
        app.use('/api/3d/tiles', createTileCleanupRouter(new PhotorealTileCleanupService(), {
            allowedWorkspaceRoots: [root],
            requireWorkspaceRoot: () => root,
            sendError: (res, err) => { res.status(500).json({ success: false, error: err?.message }); },
            isPathError: () => false
        }));
        server = app.listen(0);
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/3d/tiles`;
    });

    afterAll(() => {
        server?.close();
        fs.rmSync(root, { recursive: true, force: true });
    });

    const post = (route: string, body: unknown) =>
        fetch(`${base}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    it('returns a typed 400 when no tile is sent', async () => {
        for (const route of ['cleanup', 'cleanup-raw']) {
            const res = await post(route, { angleThresholdDegrees: 4 });
            expect(res.status).toBe(400);
            expect((await res.json()).error).toBe('missing_input');
        }
    });

    it('cleans an uploaded GLB', async () => {
        const res = await post('cleanup', { glbBase64: fs.readFileSync(INPUT_GLB).toString('base64') });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.metrics.rawTriangles).toBe(9180);
        expect(Buffer.from(data.glbBase64, 'base64').toString('utf8', 0, 4)).toBe('glTF');
    });

    it('cleans a workspace GLB by path and streams the result', async () => {
        const res = await post('cleanup-raw', { inputGlbPath: 'tile.glb' });
        expect(res.status).toBe(200);
        const buf = Buffer.from(await res.arrayBuffer());
        expect(buf.toString('utf8', 0, 4)).toBe('glTF');
    });

    it('rejects a path outside the workspace root', async () => {
        const res = await post('cleanup', { inputGlbPath: INPUT_GLB });
        expect(res.status).not.toBe(200);
    });
});
