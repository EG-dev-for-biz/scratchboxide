import { test } from 'vitest';
import * as assert from 'node:assert';
import { GoogleVectorTileService, VectorTileUnavailableError } from '../src/node/spatial/GoogleVectorTileService';

const response = (status: number, contentType: string): any => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(8)
});

test('a missing vector endpoint is reported, not staged as an empty world', async () => {
    const fetch404 = (async () => response(404, 'text/html')) as any;
    await assert.rejects(GoogleVectorTileService.fetchVectorTile(1, 2, 17, 'k', fetch404), (err: unknown) =>
        err instanceof VectorTileUnavailableError && /HTTP 404/.test((err as Error).message));
});

test('a raster PNG tile is not decoded as vector data', async () => {
    const fetchPng = (async (url: string) => String(url).includes('createSession')
        ? { ...response(200, 'application/json'), json: async () => ({ session: 's' }) }
        : response(200, 'image/png')) as any;
    await assert.rejects(GoogleVectorTileService.fetchVectorTile(3, 4, 17, 'k', fetchPng), /raster images, not vector data/);
});
