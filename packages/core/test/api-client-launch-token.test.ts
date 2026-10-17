import { afterEach, expect, test, vi } from 'vitest';

const g = globalThis as any;
const originalKeys = ['window', 'document', 'location', 'history', 'sessionStorage', 'fetch'];
const saved: Record<string, unknown> = {};
for (const key of originalKeys) saved[key] = g[key];

afterEach(() => {
    for (const key of originalKeys) {
        if (saved[key] === undefined) delete g[key]; else g[key] = saved[key];
    }
    vi.resetModules();
});

function fakeBrowser(href: string) {
    const store = new Map<string, string>();
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const location = { href, origin: new URL(href).origin };
    g.window = g;
    g.document = {};
    g.location = location;
    g.history = { replaceState: (_d: unknown, _u: string, url: string) => { location.href = url; } };
    g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
    g.fetch = async (url: string, init: { headers?: Record<string, string> } = {}) => {
        calls.push({ url: String(url), headers: init.headers ?? {} });
        return { ok: true, json: async () => ({}) };
    };
    return { location, store, calls };
}

test('launch URL token is captured, stripped from the address bar, and attached to API calls', async () => {
    const { location, store, calls } = fakeBrowser('http://127.0.0.1:3030/studio?token=abc123&x=1');
    const mod = await import('../src/common/api-client-config');
    mod.installApiAuth();

    expect(location.href).toBe('http://127.0.0.1:3030/studio?x=1');
    expect(store.get('scratchbox.launchToken')).toBe('abc123');
    expect(mod.getLaunchToken()).toBe('abc123');

    await g.fetch('/gemini/models');
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['X-Scratchbox-Token']).toBe('abc123');
});

test('without a launch URL or IPC, the client never asks the server for a token', async () => {
    const { calls } = fakeBrowser('http://127.0.0.1:3030/');
    const mod = await import('../src/common/api-client-config');
    await expect(mod.acquireLaunchToken()).resolves.toBeUndefined();
    expect(calls.some(c => c.url.includes('/api/auth/token'))).toBe(false);
});

test('token survives a reload within the tab session', async () => {
    const { store } = fakeBrowser('http://127.0.0.1:3030/');
    store.set('scratchbox.launchToken', 'persisted');
    const mod = await import('../src/common/api-client-config');
    await expect(mod.acquireLaunchToken()).resolves.toBe('persisted');
});

test('a stale session token that the server rejects is dropped and the request repeats once without it', async () => {
    const { store } = fakeBrowser('http://127.0.0.1:3030/');
    store.set('scratchbox.launchToken', 'stale');
    (g.sessionStorage as any).removeItem = (k: string) => store.delete(k);
    const seen: Array<Record<string, string>> = [];
    g.fetch = async (_url: string, init: { headers?: Record<string, string> } = {}) => {
        const headers = init.headers ?? {};
        seen.push(headers);
        const stale = headers['X-Scratchbox-Token'] === 'stale';
        const body = stale ? { error: 'unauthorized', message: 'Missing or invalid Scratchbox launch token' } : { ok: true };
        const res = { status: stale ? 401 : 200, ok: !stale, json: async () => body, clone: () => res };
        return res;
    };
    const mod = await import('../src/common/api-client-config');
    mod.installApiAuth();
    const res: any = await g.fetch('/gemini/models', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]['X-Scratchbox-Token']).toBe('stale');
    expect(seen[1]['X-Scratchbox-Token']).toBeUndefined();
    expect(store.has('scratchbox.launchToken')).toBe(false);
    expect(mod.getLaunchToken()).toBeUndefined();
});
