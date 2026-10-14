import { test } from 'vitest';
import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { FileKeyStore } from '../src/node/key-store';

async function runKeyStoreTests(): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-keystore-'));
    const file = path.join(dir, 'credentials.json');
    try {
        const store = new FileKeyStore({ filePath: file });

        assert.strictEqual(await store.getPassword('svc', 'acct'), undefined, 'empty store returns undefined');

        await store.setPassword('svc', 'acct', 'secret-1');
        assert.strictEqual(await store.getPassword('svc', 'acct'), 'secret-1');

        const mode = (await fs.stat(file)).mode & 0o777;
        assert.strictEqual(mode, 0o600, 'credential file must be user-only readable');

        const raw = await fs.readFile(file, 'utf8');
        assert.ok(!raw.includes('secret-1'), 'secret must not be stored as plaintext');

        const reopened = new FileKeyStore({ filePath: file });
        assert.strictEqual(await reopened.getPassword('svc', 'acct'), 'secret-1', 'value survives reload');
        assert.strictEqual(reopened.getPasswordSync('svc', 'acct'), 'secret-1', 'synchronous read decrypts the same value');
        assert.strictEqual(reopened.getPasswordSync('svc', 'other'), undefined);
        assert.strictEqual(new FileKeyStore({ filePath: path.join(dir, 'missing.json') }).getPasswordSync('svc', 'acct'), undefined);

        await store.deletePassword('svc', 'acct');
        assert.strictEqual(await store.getPassword('svc', 'acct'), undefined);

        // pluggable cipher (e.g. Electron safeStorage)
        const calls: string[] = [];
        const cipherStore = new FileKeyStore({
            filePath: path.join(dir, 'cipher.json'),
            cipher: {
                encrypt: v => { calls.push('enc'); return Buffer.from(v).toString('base64'); },
                decrypt: v => { calls.push('dec'); return Buffer.from(v, 'base64').toString('utf8'); }
            }
        });
        await cipherStore.setPassword('a', 'b', 'xyz');
        assert.strictEqual(await cipherStore.getPassword('a', 'b'), 'xyz');
        assert.deepStrictEqual(calls, ['enc', 'dec']);
    } finally {
        await fs.remove(dir);
    }
}

export { runKeyStoreTests };

test('key-store.test', async () => {
    await runKeyStoreTests();
});
