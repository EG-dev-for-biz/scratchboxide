import { test, afterEach } from 'vitest';
import * as assert from 'node:assert';
import { GoogleVectorTileService, VectorTileUnavailableError } from '../src/node/spatial/GoogleVectorTileService';

const origAuth = GoogleVectorTileService.authProvider;
afterEach(() => { GoogleVectorTileService.authProvider = origAuth; });

const response = (status: number, contentType: string, body: unknown): any => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
    text: async () => JSON.stringify(body)
});

test('calls vectortiles.featuretiles with the service account and the required parameters', async () => {
    GoogleVectorTileService.authProvider = async () => ({ token: 'tok', project: 'scoutscan' });
    let seen: any;
    const tile = { x: 38598, y: 49263, zoom: 17, features: [{ types: ['FEATURE_TYPE_BUILDING'], geometry: { extrudedAreas: [{ maxZ: 100, area: { type: 'TRIANGLE_FAN', vertexOffsets: { xOffsets: [10, 5, 0, -5], yOffsets: [5, 0, 5, 0] } } }] } }] };
    const out = await GoogleVectorTileService.fetchVectorTile(38598, 49263, 17, 'ignored-key', (async (url: string, init: any) => { seen = { url, init }; return response(200, 'application/json', tile); }) as any);
    const u = new URL(seen.url);
    assert.strictEqual(u.pathname, '/v1/vectortiles/featuretiles/17/38598/49263');
    for (const [k, v] of [['enableModeledVolumes', 'true'], ['alwaysIncludeBuildingFootprints', 'false'], ['languageCode', 'en-US'], ['regionCode', 'US']]) {
        assert.strictEqual(u.searchParams.get(k), v);
    }
    assert.strictEqual(u.searchParams.get('key'), null, 'API keys are refused by this API');
    assert.strictEqual(seen.init.headers.Authorization, 'Bearer tok');
    assert.strictEqual(seen.init.headers['X-Goog-User-Project'], 'scoutscan');
    assert.strictEqual(out.buildings.length, 1);
});

test('an unavailable tile is reported, not staged as an empty world', async () => {
    GoogleVectorTileService.authProvider = async () => ({ token: 'tok', project: 'p' });
    await assert.rejects(
        GoogleVectorTileService.fetchVectorTile(1, 2, 18, 'k', (async () => response(404, 'application/json', { error: { message: 'Method not found.' } })) as any),
        (err: unknown) => err instanceof VectorTileUnavailableError && /HTTP 404/.test((err as Error).message) && /Method not found/.test((err as Error).message)
    );
});
