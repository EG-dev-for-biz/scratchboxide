import { test } from 'vitest';
import * as assert from 'node:assert';
import { StreetViewGroundingImageService, isGoogleCapture } from '../src/node/spatial/StreetViewGroundingImageService';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const ok = (json: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(json), json: async () => json }) as any;
const err = (status: number, message: string) => ({ ok: false, status, text: async () => JSON.stringify({ error: { code: status, message } }) }) as any;

function service(fetchImpl: any) {
    return new StreetViewGroundingImageService({ getAccessToken: async () => 'tok', getProjectNumber: async () => '491718041258', fetchImpl, retryDelayMs: 1 });
}

test('sends the documented RetrieveGroundingImage request and decodes the redacted image', async () => {
    let seen: any;
    const svc = service(async (url: string, init: any) => { seen = { url, init }; return ok({ redactedImage: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }); });
    const out = await svc.retrieveGroundingImage({ panoId: 'P1', headingDegree: 200, pitchDegree: 120, fovDegree: 140, aspectRatio: 'RATIO_16X9' });
    assert.strictEqual(seen.url, 'https://mapmanagement.googleapis.com/v1/projects/491718041258:retrieveGroundingImage');
    assert.strictEqual(seen.init.headers.Authorization, 'Bearer tok');
    assert.strictEqual(seen.init.headers['X-Goog-User-Project'], '491718041258');
    assert.deepStrictEqual(JSON.parse(seen.init.body), {
        project: 'projects/491718041258',
        panoIdLocation: { panoId: 'P1', headingDegree: 200, pitchDegree: 90, fovDegree: 90 },
        dimension: { aspectRatio: 'RATIO_16X9' }
    });
    assert.deepStrictEqual(out.image, jpeg);
});

test('retries transient 503s, and explains ineligible user photospheres', async () => {
    let calls = 0;
    const flaky = service(async () => (++calls < 3 ? err(503, 'Deadline expired before operation could complete.') : ok({ redactedImage: { data: jpeg.toString('base64') } })));
    await flaky.retrieveGroundingImage({ panoId: 'P1' });
    assert.strictEqual(calls, 3);
    const refused = service(async () => err(403, 'Pano is not published or eligible.'));
    await assert.rejects(refused.retrieveGroundingImage({ panoId: 'CAoS...' }), /not a user photosphere/);
});

test('findGooglePano skips user photospheres for a Google capture nearby', async () => {
    const metas = [
        { status: 'OK', pano_id: 'CAoSuser', copyright: '© Alejandro Sanchez', location: { lat: 1, lng: 2 } },
        { status: 'OK', pano_id: 'googlePano', copyright: '© Google', date: '2026-04', location: { lat: 3, lng: 4 } }
    ];
    let i = 0;
    const pano = await StreetViewGroundingImageService.findGooglePano(40.75, -73.98, 'key', (async () => ok(metas[Math.min(i++, 1)])) as any);
    assert.deepStrictEqual(pano, { panoId: 'googlePano', lat: 3, lng: 4, date: '2026-04', copyright: '© Google' });
    assert.ok(isGoogleCapture('© 2026 Google') === false && isGoogleCapture('© Google'));
});
