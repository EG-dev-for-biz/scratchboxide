import { test } from 'vitest';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import { execFileSync } from 'child_process';
import { AddressInfo } from 'net';
import { BrowserProxyService } from '../src/node/browser-proxy-service';

test('a long-poll for browser actions returns as soon as an action is queued', async () => {
    const proxy = new BrowserProxyService();
    const t0 = Date.now();
    const waiting = proxy.waitForPendingActions(5_000);
    setTimeout(() => { proxy.queueAction('click', { selector: '#go' }).catch(() => undefined); }, 30);
    const actions = await waiting;
    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].action, 'click');
    assert.ok(Date.now() - t0 < 1_000, 'delivered when queued, not at the timeout');
    assert.deepStrictEqual(proxy.getPendingActions(), [], 'taken by the waiter');
    proxy.resolveAction(actions[0].id, true, {});
});

test('a long-poll times out empty, and an abandoned one leaves the next action for the next request', async () => {
    const proxy = new BrowserProxyService();
    assert.deepStrictEqual(await proxy.waitForPendingActions(20), []);
    const gone = new AbortController();
    const abandoned = proxy.waitForPendingActions(5_000, gone.signal);
    gone.abort();
    assert.deepStrictEqual(await abandoned, []);
    const pending = proxy.queueAction('scroll', { y: 100 });
    pending.catch(() => undefined);
    const next = await proxy.waitForPendingActions(1_000);
    assert.strictEqual(next.length, 1);
    assert.strictEqual(next[0].action, 'scroll');
    proxy.resolveAction(next[0].id, true, { ok: 1 });
    assert.deepStrictEqual(await pending, { ok: 1 });
});

test('the proxy verifies TLS: a self-signed certificate is refused, not proxied', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-proxy-tls-'));
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=selfsigned.example.test'], { stdio: 'ignore' });
    } catch {
        return; // no openssl on this machine: nothing to serve
    }
    const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (_req, res) => res.end('<html>impostor</html>'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const proxy = new BrowserProxyService({ allowPrivateNetwork: true, resolver: async () => [{ address: '127.0.0.1', family: 4 }] });
    try {
        await assert.rejects(() => proxy.fetchTarget(`https://selfsigned.example.test:${port}/`), (err: any) => {
            assert.ok(/certificate|self.signed|unable to verify/i.test(String(err?.message ?? err)), String(err?.message ?? err));
            return true;
        });
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
