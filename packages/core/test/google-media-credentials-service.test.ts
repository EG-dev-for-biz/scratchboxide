import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import { GoogleMediaCredentialsService, describeGoogleCredentialError } from '../src/node/google-media-credentials-service';

async function runGoogleMediaCredentialTests(): Promise<void> {
    console.log('🧪 Running Google media credential tests...');
    let storedPassword: string | undefined;
    const fakeKeyStore = {
        setPassword: async (_service: string, _account: string, password: string) => {
            storedPassword = password;
        },
        getPassword: async () => storedPassword,
        deletePassword: async () => true,
        findPassword: async () => storedPassword,
        findCredentials: async () => [],
        keys: async () => []
    };

    const service = new GoogleMediaCredentialsService();
    (service as any).keyStore = fakeKeyStore;
    (service as any).removeLegacyPlaintextKey = async () => undefined;

    const invalid = await service.saveApiKey('not-a-key');
    assert.strictEqual(invalid.success, false);
    assert.strictEqual(storedPassword, undefined);

    const key = `AIza${'A'.repeat(32)}`;
    const saved = await service.saveApiKey(key);
    assert.strictEqual(saved.success, true);
    assert.strictEqual(saved.authMethod, 'api-key');
    assert.strictEqual(storedPassword, key);
    assert.strictEqual(JSON.stringify(saved).includes(key), false, 'Credential responses must not echo secrets');

    console.log('🎉 GOOGLE MEDIA CREDENTIAL TESTS PASSED');
}

test('google-media-credentials-service.test', async () => {
    await runGoogleMediaCredentialTests();
}, 180_000);

test('describeGoogleCredentialError extracts Google\'s message and adds a fix for blocked keys', () => {
    const blocked = new Error('got status: 403 Forbidden. ' + JSON.stringify({
        error: {
            code: 403,
            message: 'Requests to this API generativelanguage.googleapis.com method google.ai.generativelanguage.v1beta.GenerativeService.CountTokens are blocked.',
            status: 'PERMISSION_DENIED',
            details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_SERVICE_BLOCKED', domain: 'googleapis.com' }]
        }
    }));
    const message = describeGoogleCredentialError(blocked);
    assert.ok(message.startsWith('Could not verify credentials with Google: Requests to this API'), message);
    assert.ok(message.includes('aistudio.google.com/apikey'), message);
    assert.ok(!message.includes('"code"'), 'raw JSON must not leak into the message');

    assert.ok(describeGoogleCredentialError(new Error('invalid_grant: Invalid JWT Signature.')).includes('deleted or revoked'));
    assert.strictEqual(describeGoogleCredentialError(new Error('fetch failed')), 'Could not verify credentials with Google: fetch failed');
});

test('the Vertex media client defaults to the chat location, where Gemini 3.x image models are served', async () => {
    const saved = { vertex: process.env.SCRATCHBOX_VERTEX_LOCATION, cloud: process.env.GOOGLE_CLOUD_LOCATION };
    const restore = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    };
    const service = new GoogleMediaCredentialsService();
    (service as any).getVertexAuth = async () => ({ project: 'test-project' });
    const locationOf = async (location?: string) => ((await service.createVertexClient(location)) as any).apiClient.getLocation();
    try {
        delete process.env.SCRATCHBOX_VERTEX_LOCATION;
        // .env.example sets this; us-central1 serves only gemini-2.5-flash-image, so images silently downgraded there.
        process.env.GOOGLE_CLOUD_LOCATION = 'us-central1';
        assert.strictEqual(await locationOf(), 'global');

        process.env.SCRATCHBOX_VERTEX_LOCATION = 'europe-west4';
        assert.strictEqual(await locationOf(), 'europe-west4', 'follows the same override as the chat client');
        assert.strictEqual(await locationOf('us-east5'), 'us-east5', 'an explicit location still wins');
    } finally {
        restore('SCRATCHBOX_VERTEX_LOCATION', saved.vertex);
        restore('GOOGLE_CLOUD_LOCATION', saved.cloud);
    }
});

test('Vertex is used whenever its credentials are configured, even with an API key stored; the key only without them', async () => {
    const service = new GoogleMediaCredentialsService();
    (service as any).getApiKey = async () => 'AIzaFAKEKEYFORTESTSONLY0123456789';
    (service as any).getVertexAuth = async () => ({ project: 'test-project' });
    (service as any).hasVertexCredentials = () => true;
    assert.strictEqual(((await service.createClient()) as any).vertexai, true);
    (service as any).hasVertexCredentials = () => false;
    assert.notStrictEqual(((await service.createClient()) as any).vertexai, true);
});

test('warns once when GOOGLE_CLOUD_LOCATION differs from the Vertex location in use', async () => {
    const { GoogleMediaCredentialsService } = await import('../src/node/google-media-credentials-service');
    const saved = { loc: process.env.GOOGLE_CLOUD_LOCATION, proj: process.env.GOOGLE_CLOUD_PROJECT };
    process.env.GOOGLE_CLOUD_LOCATION = 'europe-west4';
    process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
    try {
        const svc = new GoogleMediaCredentialsService({ getPassword: async () => undefined, setPassword: async () => undefined, deletePassword: async () => false });
        (svc as any).getVertexAuth = async () => ({ project: 'test-project' });
        await svc.createVertexClient('global');
        await svc.createVertexClient('global');
        const relevant = warnings.filter(w => w.includes('GOOGLE_CLOUD_LOCATION'));
        if (relevant.length !== 1 || !relevant[0].includes('SCRATCHBOX_VERTEX_LOCATION')) throw new Error(`expected one warning naming SCRATCHBOX_VERTEX_LOCATION, got ${JSON.stringify(warnings)}`);
    } finally {
        console.warn = orig;
        if (saved.loc === undefined) delete process.env.GOOGLE_CLOUD_LOCATION; else process.env.GOOGLE_CLOUD_LOCATION = saved.loc;
        if (saved.proj === undefined) delete process.env.GOOGLE_CLOUD_PROJECT; else process.env.GOOGLE_CLOUD_PROJECT = saved.proj;
    }
});
