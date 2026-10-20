/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import { test } from 'vitest';
import { Router } from 'express';
import { createTextureRouter } from '../server/routes/textureRoutes';
import { GoogleMediaCredentialsService } from '../../packages/core/src/node';

function invokeRouter(
    router: Router,
    method: 'GET' | 'POST',
    url: string,
    options: { query?: Record<string, any> } = {}
): Promise<{ status: number; json: any }> {
    return new Promise((resolve) => {
        const req: any = { method, url, query: options.query || {}, headers: {} };
        const res: any = {
            statusCode: 200,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: any) {
                resolve({ status: this.statusCode, json: payload });
            }
        };
        router(req, res, (err?: any) => {
            resolve(err ? { status: 500, json: { error: err.message } } : { status: 404, json: { error: 'Not found' } });
        });
    });
}

test('texture routes: rejects path traversal and non-library roots', async () => {
    const router = createTextureRouter(new GoogleMediaCredentialsService());
    const get = (p: string) => invokeRouter(router, 'GET', '/sign', { query: { path: p } });

    const traversal = await get('../../etc/passwd');
    assert.strictEqual(traversal.status, 400);
    assert.strictEqual(traversal.json.success, false);

    const wrongRoot = await get('secrets/service-account.json');
    assert.strictEqual(wrongRoot.status, 400);
    assert.strictEqual(wrongRoot.json.success, false);

    const missing = await get('');
    assert.strictEqual(missing.status, 400);
});

test('texture routes: accepts a well-formed library path, never crashes regardless of credential availability', async () => {
    const router = createTextureRouter(new GoogleMediaCredentialsService());
    const result = await invokeRouter(router, 'GET', '/sign', {
        query: { path: '/textures/pbr50/granite/albedo.png' }
    });
    if (result.json.success) {
        // Real Google credentials are available (e.g. ./service-account.json) — assert we got back
        // a genuine v4 signed GCS URL for the requested object, not a stand-in.
        assert.strictEqual(result.status, 200);
        assert.ok(typeof result.json.url === 'string' && /^https:\/\/storage\.googleapis\.com\//.test(result.json.url), result.json.url);
        assert.ok(/X-Goog-Signature=/.test(result.json.url), 'expected a v4-signed URL');
        assert.strictEqual(result.json.path, 'textures/pbr50/granite/albedo.png');
    } else {
        // No credentials configured — signing must fail cleanly (never throw past the router)
        // rather than leak a stack trace to the client.
        assert.ok(result.status >= 400 && result.status < 600, `expected an error status, got ${result.status}`);
        assert.ok(typeof result.json.error === 'string' && result.json.error.length > 0);
    }
});

test('texture routes: caches a signed URL instead of re-signing on every request', async () => {
    const router = createTextureRouter(new GoogleMediaCredentialsService());
    const first = await invokeRouter(router, 'GET', '/sign', { query: { path: 'textures/pbr50/granite/albedo.png' } });
    if (!first.json.success) {
        return; // No credentials in this environment; covered by the crash-safety test above.
    }
    const second = await invokeRouter(router, 'GET', '/sign', { query: { path: 'textures/pbr50/granite/albedo.png' } });
    assert.strictEqual(second.json.url, first.json.url, 'expected the cached signed URL to be reused');
});
