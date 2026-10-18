import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { analyticalGroomHandlers } from '../src/node/gemini/tools/spatial-tools';
import { MapsImageryGroundingService, MapsImageryGroundingError } from '../src/node/spatial/MapsImageryGroundingService';
import { SpatialVectorDataService } from '../src/node/spatial/SpatialVectorDataService';

const SENTINEL_KEY = 'AIzaSENTINEL_configured_key_must_not_leak_0123';

// 1x1 white PNG, returned for every Street View face request.
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

function streetViewFetch(panoId: string): typeof fetch {
    return (async (url: any) => {
        const u = String(url);
        if (u.includes('metadata')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ status: 'OK', pano_id: panoId, date: '2024-06', location: { lat: 35.66, lng: 139.7 } })
            } as any;
        }
        return {
            ok: true,
            status: 200,
            arrayBuffer: async () => PNG_1PX.buffer.slice(PNG_1PX.byteOffset, PNG_1PX.byteOffset + PNG_1PX.byteLength)
        } as any;
    }) as any;
}

describe('tool results never carry the configured API key', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('maps_imagery_grounding_pano result and summary are keyless', async () => {
        vi.stubEnv('GOOGLE_MAPS_API_KEY', SENTINEL_KEY);
        vi.stubGlobal('fetch', streetViewFetch('pano_leak_test'));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-keyleak-'));
        try {
            const out = await analyticalGroomHandlers.maps_imagery_grounding_pano(
                { panoId: 'pano_leak_test', canvasWidth: 64, canvasHeight: 32, outputImagePath: path.join(dir, 'p.png') },
                { workspaceRoot: dir } as any
            );
            const serialized = JSON.stringify(out);
            expect(serialized).not.toContain(SENTINEL_KEY);
            expect((out.resultPayload as any).viewerUrl).toContain('pano=pano_leak_test');
            expect(fs.existsSync(path.join(dir, 'p.png'))).toBe(true);
        } finally {
            await fs.remove(dir);
        }
    });

    it('satellite metadata in spatial datasets is keyless', () => {
        const meta = SpatialVectorDataService.getSatelliteFallback({ latitude: 40.7, longitude: -74, apiKey: SENTINEL_KEY });
        expect(JSON.stringify(meta)).not.toContain(SENTINEL_KEY);
        expect(meta.staticMapUrl).toContain('maptype=satellite');
    });

    it('refuses with a typed error instead of a hard-coded panorama when nothing resolves', async () => {
        await expect(
            MapsImageryGroundingService.groundAndProjectStreetViewPanorama({ apiKey: 'k', fetchImpl: streetViewFetch('x') })
        ).rejects.toMatchObject({ name: 'MapsImageryGroundingError', code: 'NO_PANORAMA' });
    });

    it('refuses with a typed error instead of a placeholder Vertex project', async () => {
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
        let called = false;
        const fetchImpl = (async () => {
            called = true;
            return { ok: true, json: async () => ({}) } as any;
        }) as any;
        const err = await MapsImageryGroundingService.queryVertexMapsImagery('somewhere', { fetchImpl }).catch(e => e);
        expect(err).toBeInstanceOf(MapsImageryGroundingError);
        expect(err.code).toBe('NO_VERTEX_PROJECT');
        expect(called).toBe(false);
    });
});
