import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { test } from 'vitest';
import express from 'express';
import { createBrowserRouter } from '../server/routes/browserRoutes';
import { BrowserProxyService } from '../../packages/core/src/node/browser-proxy-service';

test('GET /pending-actions?waitMs holds the request until the agent queues an action', async () => {
    const proxy = new BrowserProxyService();
    const app = express();
    app.use(express.json());
    app.use('/api/browser', createBrowserRouter(proxy));
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/browser`;
    try {
        // Without waitMs: the old immediate answer.
        assert.deepStrictEqual(await (await fetch(`${base}/pending-actions`)).json(), []);
        const t0 = Date.now();
        const held = fetch(`${base}/pending-actions?waitMs=5000`).then(r => r.json());
        await new Promise(r => setTimeout(r, 80));
        const done = proxy.queueAction('type', { selector: '#q', text: 'hi' });
        const actions = await held;
        assert.strictEqual(actions.length, 1);
        assert.strictEqual(actions[0].action, 'type');
        const ms = Date.now() - t0;
        assert.ok(ms >= 70 && ms < 2000, `answered when queued (${ms} ms)`);
        await fetch(`${base}/action-result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: actions[0].id, success: true, result: { typed: true } }) });
        assert.deepStrictEqual(await done, { typed: true });
        // A held request that times out answers [].
        assert.deepStrictEqual(await (await fetch(`${base}/pending-actions?waitMs=50`)).json(), []);
    } finally {
        server.close();
    }
});
