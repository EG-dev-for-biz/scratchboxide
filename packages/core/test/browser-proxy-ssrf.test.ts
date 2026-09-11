import { test } from 'vitest';
import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { BrowserProxyService } from '../src/node/browser-proxy-service';

function startEchoServer(): Promise<{ server: http.Server; port: number; requests: http.IncomingMessage[] }> {
    const requests: http.IncomingMessage[] = [];
    const server = http.createServer((req, res) => {
        requests.push(req);
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ headers: req.headers, body, url: req.url }));
        });
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: (server.address() as AddressInfo).port, requests });
        });
    });
}

test('browser proxy blocks loopback, link-local, RFC1918 and metadata targets by default', async () => {
    const previous = process.env.SCRATCHBOX_PROXY_ALLOW_PRIVATE;
    delete process.env.SCRATCHBOX_PROXY_ALLOW_PRIVATE;
    try {
        const proxy = new BrowserProxyService();
        const blocked = [
            'http://localhost:3001/',
            'http://127.0.0.1:3001/gemini/status',
            'http://127.1.2.3/',
            'http://[::1]:3001/',
            'http://0.0.0.0:3001/',
            'http://169.254.169.254/latest/meta-data',
            'http://metadata.google.internal/computeMetadata/v1/',
            'http://metadata/computeMetadata/v1/',
            'http://10.0.0.1/',
            'http://192.168.1.1/',
            'http://172.16.0.1/',
            'http://172.31.255.255/',
            'http://100.64.0.1/',
            'http://[fd00::1]/',
            'http://[fe80::1]/',
            'http://[::ffff:127.0.0.1]/',
            'http://[::ffff:10.0.0.1]/'
        ];
        for (const target of blocked) {
            await assert.rejects(() => proxy.validateTarget(target), (err: any) => {
                assert.ok(/blocked/i.test(err.message), `${target}: ${err.message}`);
                return true;
            }, `expected ${target} to be blocked`);
        }

        // Existing message contract for metadata hosts is preserved.
        await assert.rejects(
            () => proxy.validateTarget('http://169.254.169.254/latest/meta-data'),
            /metadata targets are blocked/
        );

        // allowPrivateNetwork from a request policy body must be ignored.
        await assert.rejects(
            () => proxy.validateTarget('http://127.0.0.1:3001/', { allowPrivateNetwork: true } as any),
            /blocked/i
        );
        await assert.rejects(
            () => proxy.fetchTarget('http://127.0.0.1:3001/', { policy: { allowPrivateNetwork: true } as any }),
            /blocked/i
        );

        // Non-http schemes and embedded credentials are rejected too.
        await assert.rejects(() => proxy.validateTarget('file:///etc/passwd'), /Unsupported/);
        await assert.rejects(() => proxy.validateTarget('ftp://example.com/'), /Unsupported/);
        await assert.rejects(() => proxy.validateTarget('http://user:pass@example.com/'), /credentials/);
    } finally {
        if (previous === undefined) delete process.env.SCRATCHBOX_PROXY_ALLOW_PRIVATE; else process.env.SCRATCHBOX_PROXY_ALLOW_PRIVATE = previous;
    }
});

test('browser proxy rejects hostnames that resolve to private addresses (DNS rebinding guard)', async () => {
    const proxy = new BrowserProxyService({
        allowPrivateNetwork: false,
        resolver: async hostname => {
            if (hostname === 'rebind.example.test') {
                return [{ address: '10.0.0.5', family: 4 }];
            }
            if (hostname === 'public.example.test') {
                return [{ address: '93.184.216.34', family: 4 }];
            }
            throw new Error(`ENOTFOUND ${hostname}`);
        }
    });

    await assert.rejects(() => proxy.validateTarget('http://rebind.example.test/'), /blocked/i);
    const resolved = await proxy.validateTarget('http://public.example.test/');
    assert.deepStrictEqual(resolved.addresses.map(a => a.address), ['93.184.216.34']);
});

test('browser proxy pins the resolved IP for the connection and strips caller credentials + hop-by-hop headers', async () => {
    const { server, port, requests } = await startEchoServer();
    try {
        // A resolver that only knows a fake public hostname mapping to our local echo server.
        // If the pinned lookup were not used, the connection would fail with ENOTFOUND.
        const proxy = new BrowserProxyService({
            allowPrivateNetwork: true,
            resolver: async hostname => {
                if (hostname === 'pinned.example.test') {
                    return [{ address: '127.0.0.1', family: 4 }];
                }
                throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
            }
        });

        const result = await proxy.fetchTarget(`http://pinned.example.test:${port}/echo?x=1`, {
            method: 'POST',
            headers: {
                'authorization': 'Bearer super-secret',
                'cookie': 'session=abc',
                'x-scratchbox-token': 'launch-token',
                'proxy-authorization': 'Basic xyz',
                'connection': 'keep-alive',
                'transfer-encoding': 'chunked',
                'upgrade': 'websocket',
                'te': 'trailers',
                'host': '127.0.0.1:3001',
                'origin': 'http://127.0.0.1:3000',
                'referer': 'http://127.0.0.1:3000/',
                'content-type': 'application/json',
                'x-custom-safe': 'yes'
            },
            body: { hello: 'world' }
        });

        assert.strictEqual(result.statusCode, 200);
        assert.strictEqual(requests.length, 1, 'echo server should have received exactly one request');
        const upstream = requests[0].headers;
        // `connection` is always set by Node's own agent, so it is checked via sanitizeRequestHeaders below.
        for (const stripped of ['authorization', 'cookie', 'x-scratchbox-token', 'proxy-authorization', 'transfer-encoding', 'upgrade', 'te', 'origin', 'referer']) {
            assert.strictEqual(upstream[stripped], undefined, `header "${stripped}" must not be forwarded upstream`);
        }
        const sanitized = proxy.sanitizeRequestHeaders({ connection: 'keep-alive', 'keep-alive': 'timeout=5', trailer: 'x', 'X-Custom-Safe': 'yes' });
        assert.deepStrictEqual(sanitized, { 'X-Custom-Safe': 'yes' }, 'hop-by-hop headers must be stripped before forwarding');
        assert.strictEqual(upstream['x-custom-safe'], 'yes', 'benign headers are forwarded');
        assert.strictEqual(upstream['host'], `pinned.example.test:${port}`, 'Host header must be the target host, not the API origin');
        const echoed = JSON.parse(result.body.toString());
        assert.strictEqual(echoed.body, JSON.stringify({ hello: 'world' }));
        assert.strictEqual(echoed.url, '/echo?x=1');
    } finally {
        (server as any).closeAllConnections?.();
        server.close();
    }
});

test('SCRATCHBOX_PROXY_ALLOW_PRIVATE=1 opts the server into private targets', async () => {
    const previous = process.env.SCRATCHBOX_PROXY_ALLOW_PRIVATE;
    process.env.SCRATCHBOX_PROXY_ALLOW_PRIVATE = '1';
    try {
        const proxy = new BrowserProxyService();
        const resolved = await proxy.validateTarget('http://127.0.0.1:3999/');
        assert.strictEqual(resolved.addresses[0].address, '127.0.0.1');
        // Metadata hosts stay blocked even with private networks enabled.
        await assert.rejects(() => proxy.validateTarget('http://169.254.169.254/'), /metadata targets are blocked/);
    } finally {
        if (previous === undefined) delete process.env.SCRATCHBOX_PROXY_ALLOW_PRIVATE; else process.env.SCRATCHBOX_PROXY_ALLOW_PRIVATE = previous;
    }
});
