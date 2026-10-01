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
import { GoogleMediaCredentialsService } from '../src/node/google-media-credentials-service';

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
