// @vitest-environment node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The scratchbox.ai desktop connection (desktop-account.ts, desktop-vault.ts) and the Studio client's bearer transport:
 * the real loopback callback, PKCE, refresh rotation and fencing, revoke, media signing, the vaults on disk. Every
 * token here is made up by the test; nothing leaves the machine.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopAccount, DesktopAccountOptions, StoredDesktopGrant, parseDesktopIdentity } from '../src/node/scratchbox-account/desktop-account';
import { EncryptedDesktopVault, KeyFileDesktopVault, createDesktopVault } from '../src/node/scratchbox-account/desktop-vault';
import { FileKeyStore } from '../src/node/key-store';
import { callStudioRequest, callStudioTool, studioMcpConfig } from '../src/node/scratchbox-studio/studio-mcp-client';

const ORIGIN = 'https://scratchbox.example';
const token = (letter = 'a') => ({
    access_token: `sbmcp_${letter.repeat(43)}`, refresh_token: `sbdr_${letter.repeat(43)}`,
    token_type: 'Bearer', expires_in: 899, scope: 'workspace:read workspace:write',
    workspace_id: 8, connection_id: 3, mcp_path: '/api/mcp/canvas',
});
const grant = (letter = 'a'): StoredDesktopGrant => ({
    origin: ORIGIN, workspaceId: 8, connectionId: 3, refreshToken: token(letter).refresh_token,
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
// Use actual Node HTTP even when the surrounding app's test setup mocks global fetch.
function visit(url: URL, options: { headers?: Record<string, string>; path?: string } = {}): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
        const request = get(url, options, response => {
            response.resume();
            response.once('end', () => resolve({ status: response.statusCode! }));
        });
        request.once('error', reject);
        request.setTimeout(2000, () => request.destroy(new Error('Loopback callback timed out.')));
    });
}
const accounts: DesktopAccount[] = [];
const directories: string[] = [];
afterEach(async () => {
    accounts.splice(0).forEach(account => account.close());
    await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function fixture(overrides: Partial<DesktopAccountOptions> = {}) {
    const vault = {
        assertAvailable: vi.fn(), load: vi.fn(async (): Promise<StoredDesktopGrant | null> => null),
        save: vi.fn(async (_grant: StoredDesktopGrant) => undefined), clear: vi.fn(async () => undefined),
    };
    const http = vi.fn(async () => json(token()));
    const account = new DesktopAccount({
        origin: ORIGIN, vault, fetch: http as unknown as typeof fetch,
        openBrowser: async link => {
            const request = new URL(link), callback = new URL(request.searchParams.get('redirect_uri')!);
            callback.searchParams.set('state', request.searchParams.get('state')!);
            callback.searchParams.set('code', `sbdc_${'c'.repeat(43)}`);
            expect((await visit(callback)).status).toBe(200);
        }, ...overrides,
    });
    accounts.push(account);
    return { account, vault, http };
}

describe('native Scratchbox connection', () => {
    it('runs the actual IP-only loopback callback and exchanges a bound PKCE verifier', async () => {
        let browserRequest: URL | undefined;
        const f = fixture({ openBrowser: async link => {
            browserRequest = new URL(link);
            const callback = new URL(browserRequest.searchParams.get('redirect_uri')!);
            expect(callback.hostname).toBe('127.0.0.1');
            expect(Number(callback.port)).toBeGreaterThan(1023);
            callback.searchParams.set('state', browserRequest.searchParams.get('state')!);
            callback.searchParams.set('code', `sbdc_${'c'.repeat(43)}`);
            expect((await visit(callback)).status).toBe(200);
        } });
        await f.account.connect();
        const [, init] = f.http.mock.calls[0] as unknown as [string, RequestInit];
        const body = JSON.parse(init.body as string);
        expect(createHash('sha256').update(body.code_verifier).digest('base64url'))
            .toBe(browserRequest!.searchParams.get('code_challenge'));
        expect(body.redirect_uri).toBe(browserRequest!.searchParams.get('redirect_uri'));
        expect(body.client_id).toBe('scratchbox-ide');
        expect(init.redirect).toBe('error');
        expect(init.headers).not.toHaveProperty('Origin');
        expect(f.vault.save).toHaveBeenCalledWith(grant());
        expect(JSON.stringify(f.account.status())).not.toContain('sbmcp_');
        expect(JSON.stringify(f.account.status())).not.toContain('sbdr_');
    });
    it('does not consume the attempt on a wrong state, duplicate state, Origin or Host', async () => {
        const f = fixture({ openBrowser: async link => {
            const request = new URL(link), callback = new URL(request.searchParams.get('redirect_uri')!);
            expect((await visit(callback, { path: 'http://[' })).status).toBe(400);
            callback.searchParams.set('state', 'bad');
            callback.searchParams.set('code', `sbdc_${'c'.repeat(43)}`);
            expect((await visit(callback)).status).toBe(400);
            callback.searchParams.set('state', request.searchParams.get('state')!);
            callback.searchParams.append('state', request.searchParams.get('state')!);
            expect((await visit(callback)).status).toBe(400);
            callback.searchParams.delete('state');
            callback.searchParams.set('state', request.searchParams.get('state')!);
            expect((await visit(callback, { headers: { Origin: 'https://evil.example' } })).status).toBe(400);
            expect((await visit(callback, { headers: { Host: 'evil.example' } })).status).toBe(400);
            expect((await visit(callback)).status).toBe(200);
        } });
        await f.account.connect();
        // one token exchange (the identity read for display that follows is not part of the attempt)
        expect(f.http.mock.calls.filter(c => String((c as unknown[])[0]).endsWith('/api/auth/desktop/token'))).toHaveLength(1);
    });
    it('handles explicit denial without exchanging or saving a token', async () => {
        const f = fixture({ openBrowser: async link => {
            const request = new URL(link), callback = new URL(request.searchParams.get('redirect_uri')!);
            callback.searchParams.set('state', request.searchParams.get('state')!);
            callback.searchParams.set('error', 'access_denied');
            await visit(callback);
        } });
        await expect(f.account.connect()).rejects.toThrow('declined');
        expect(f.http).not.toHaveBeenCalled();
        expect(f.vault.save).not.toHaveBeenCalled();
    });
    it('times out even if opening the system browser never finishes', async () => {
        const f = fixture({ callbackTimeoutMs: 30, openBrowser: () => new Promise(() => undefined) });
        await expect(f.account.connect()).rejects.toThrow('expired');
        expect(f.account.status().connecting).toBe(false);
    });
    it('cancels a pending attempt and refuses double-start', async () => {
        let opened!: () => void;
        const ready = new Promise<void>(resolve => { opened = resolve; });
        const f = fixture({ openBrowser: async () => { opened(); } });
        const pending = f.account.connect();
        const failed = expect(pending).rejects.toThrow('cancelled');
        await ready;
        await expect(f.account.connect()).rejects.toThrow('Finish or cancel');
        await f.account.cancel();
        await failed;
        expect(f.account.status().connected).toBe(false);
    });
    it('serializes concurrent refreshes and atomically stores the rotated refresh', async () => {
        const f = fixture();
        f.vault.load.mockResolvedValue(grant());
        f.http.mockImplementation(async () => json(token('b')));
        await f.account.restore();
        const tokens = await Promise.all(Array.from({ length: 8 }, () => f.account.accessToken()));
        expect(new Set(tokens)).toEqual(new Set([token('b').access_token]));
        expect(f.http).toHaveBeenCalledTimes(1);
        expect(f.vault.save).toHaveBeenCalledTimes(1);
        expect(f.vault.save).toHaveBeenCalledWith(grant('b'));
    });
    it.each(['lost response', 'malformed response', 'wrong workspace', 'unchanged refresh'])(
        'requires reconnect rather than replaying an uncertain refresh: %s', async kind => {
            const f = fixture();
            f.vault.load.mockResolvedValue(grant());
            f.http.mockImplementation(async () => {
                if (kind === 'lost response') throw new Error('private transport detail');
                if (kind === 'malformed response') return json({ ok: true, data: token('b') });
                if (kind === 'wrong workspace') return json({ ...token('b'), workspace_id: 99 });
                return json(token('a'));
            });
            await f.account.restore();
            await expect(f.account.accessToken()).rejects.toThrow('Reconnect');
            await expect(f.account.accessToken()).rejects.toThrow('Reconnect');
            expect(f.http).toHaveBeenCalledTimes(1);
            expect(f.vault.clear).toHaveBeenCalled();
        });
    it('does not resurrect tokens when a late refresh completes after disconnect', async () => {
        let release!: (value: Response) => void;
        const f = fixture();
        f.vault.load.mockResolvedValue(grant());
        f.http.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        await f.account.restore();
        const pending = expect(f.account.accessToken()).rejects.toThrow();
        // Invalidate the native session even when an injected transport ignores AbortSignal.
        f.account.close();
        release(json(token('b')));
        await pending;
        expect(f.vault.save).not.toHaveBeenCalled();
    });
    it('does not remove an established sign-in when cancelling a nonexistent pending attempt', async () => {
        const f = fixture();
        await f.account.connect();
        await f.account.cancel();
        expect(f.account.status().connected).toBe(true);
        expect(f.vault.clear).not.toHaveBeenCalled();
    });
    it('clears a token save that was already in progress when sign-in is cancelled', async () => {
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const f = fixture();
        f.vault.save.mockImplementation(async () => { entered(); await gate; });
        const connection = expect(f.account.connect()).rejects.toThrow();
        await started;
        const cancelled = f.account.cancel();
        release();
        await Promise.all([connection, cancelled]);
        expect(f.vault.clear).toHaveBeenCalled();
        expect(f.account.status().connected).toBe(false);
        expect(f.vault.clear.mock.invocationCallOrder[0]).toBeGreaterThan(f.vault.save.mock.invocationCallOrder[0]);
    });
    it('fences an old tool configuration after disconnect and connection to another workspace', async () => {
        const f = fixture();
        await f.account.connect();
        const oldConfig = f.account.studioConfig()!;
        f.http.mockImplementation(async () => json({ revoked: true }));
        await f.account.disconnect();
        f.http.mockImplementation(async () => json({ ...token('b'), workspace_id: 9, connection_id: 4 }));
        await f.account.connect();
        await expect(oldConfig.getAccessToken()).rejects.toThrow();
        expect(f.account.studioConfig()!.workspaceId).toBe('9');
    });
    it('refuses account switching while a workspace remains connected', async () => {
        const f = fixture();
        await f.account.connect();
        await expect(f.account.connect()).rejects.toThrow('Disconnect the current');
    });
    it('revalidates token freshness on every RPC without exposing credentials to callers', async () => {
        let clock = 0;
        const f = fixture({ now: () => clock });
        await f.account.connect();
        const config = f.account.studioConfig()!;
        clock = 900_000;
        f.http.mockImplementation(async () => json(token('b')));
        expect(await config.getAccessToken()).toBe(token('b').access_token);
        expect(f.vault.save).toHaveBeenLastCalledWith(grant('b'));
    });
    it('signs workspace media through the authenticated endpoint, never cookie-only URLs', async () => {
        const f = fixture();
        await f.account.connect();
        f.http.mockImplementation(async () => json({ url: 'https://media.example/signed-image' }));
        expect(await f.account.mediaUrl('/api/storage/serve?path=uploads%2Fworkspaces%2F8%2Fa.png'))
            .toBe('https://media.example/signed-image');
        const [url, init] = f.http.mock.calls.at(-1)! as unknown as [string, RequestInit];
        expect(url).toContain('/api/auth/desktop/media?path=uploads%2Fworkspaces%2F8%2Fa.png');
        expect(init.headers).toHaveProperty('Authorization', `Bearer ${token().access_token}`);
        await expect(f.account.mediaUrl('https://evil.example/api/storage/serve?path=secret')).rejects.toThrow();
    });
    it('revokes the remote device before clearing local credentials', async () => {
        const f = fixture();
        await f.account.connect();
        f.http.mockImplementation(async () => json({ revoked: true }));
        expect(await f.account.disconnect()).toEqual({ revoked: true });
        const [url, init] = f.http.mock.calls.at(-1)! as unknown as [string, RequestInit];
        expect(url).toBe(`${ORIGIN}/api/auth/desktop/me`);
        expect(init.method).toBe('DELETE');
        expect(f.vault.clear).toHaveBeenCalled();
        expect(f.account.status().connected).toBe(false);
    });
    it('clears locally but honestly reports unconfirmed server revocation', async () => {
        const f = fixture();
        await f.account.connect();
        f.http.mockImplementation(async () => { throw new Error('offline'); });
        expect(await f.account.disconnect()).toEqual({ revoked: false });
        expect(f.account.status().connected).toBe(false);
        expect(f.vault.clear).toHaveBeenCalled();
    });
    it.each(['http://scratchbox.example', 'https://scratchbox.example/path', 'https://user:pass@scratchbox.example'])(
        'refuses an unsafe hosted endpoint %s', origin => {
            expect(() => fixture({ origin })).toThrow('HTTPS origin');
        });
    it('accepts plain HTTP only on a loopback host (a local stand-in)', () => {
        expect(fixture({ origin: 'http://127.0.0.1:3175' }).account.origin).toBe('http://127.0.0.1:3175');
        expect(fixture({ origin: 'http://localhost:3175' }).account.origin).toBe('http://localhost:3175');
    });
    it('never revives a grant saved for another hosted origin', async () => {
        const f = fixture();
        f.vault.load.mockResolvedValue({ ...grant(), origin: 'https://other.example' });
        await expect(f.account.restore()).rejects.toThrow();
        expect(f.account.status().connected).toBe(false);
    });
});

describe('desktop MCP bearer transport', () => {
    it('never uses internal credentials or user impersonation headers', async () => {
        const http = vi.fn(async () => json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { accepted: true } } }));
        const config = { endpoint: `${ORIGIN}/api/mcp/canvas`, workspaceId: '8', getAccessToken: async () => token().access_token };
        expect(await callStudioTool(config, 'canvas.list', {}, { fetch: http })).toEqual({ accepted: true });
        const [, init] = http.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.headers).toHaveProperty('Authorization', `Bearer ${token().access_token}`);
        expect(Object.keys(init.headers!)).not.toContain('x-internal-secret');
        expect(Object.keys(init.headers!)).not.toContain('x-internal-user-id');
        expect(init.redirect).toBe('error');
    });
    it('discovers actual tools rather than hardcoding the hosted tool inventory', async () => {
        const http = vi.fn(async () => json({ result: { tools: [{ name: 'canvas.list' }] } }));
        expect(await callStudioRequest({ endpoint: `${ORIGIN}/api/mcp/canvas`, workspaceId: '8',
            getAccessToken: async () => token().access_token }, 'tools/list', {}, { fetch: http }))
            .toEqual({ tools: [{ name: 'canvas.list' }] });
    });
    it('does not replay failed mutating requests', async () => {
        const http = vi.fn(async () => json({ error: 'unavailable' }, 503));
        await expect(callStudioTool({ endpoint: `${ORIGIN}/api/mcp/canvas`, workspaceId: '8',
            getAccessToken: async () => token().access_token }, 'canvas.edit', {}, { fetch: http })).rejects.toThrow('not retried');
        expect(http).toHaveBeenCalledTimes(1);
    });
    it('prefers the connected workspace over the development secret, which is used only while nothing is connected', async () => {
        const env = { SCRATCHBOX_MCP_SECRET: 'dev-only', SCRATCHBOX_MCP_USER_ID: '4', SCRATCHBOX_MCP_WORKSPACE_ID: '8' };
        const f = fixture();
        expect(studioMcpConfig(env, f.account)).toMatchObject({ secret: 'dev-only' });
        await f.account.connect();
        const config = studioMcpConfig(env, f.account)!;
        expect(config.secret).toBeUndefined();
        expect(await config.getAccessToken!()).toBe(token().access_token);
    });
    it('refuses to send a bearer token to anything but the MCP route over HTTPS or loopback', async () => {
        const http = vi.fn(async () => json({ result: {} }));
        for (const endpoint of ['http://scratchbox.example/api/mcp/canvas', `${ORIGIN}/api/other`, `${ORIGIN}/api/mcp/canvas?x=1`]) {
            await expect(callStudioRequest({ endpoint, workspaceId: '8', getAccessToken: async () => token().access_token }, 'tools/list', {}, { fetch: http }))
                .rejects.toThrow('Invalid Scratchbox MCP endpoint');
        }
        expect(http).not.toHaveBeenCalled();
    });
    it('forgets the connection when the MCP route refuses its token (revoked from the web)', async () => {
        const f = fixture();
        await f.account.connect();
        const config = f.account.studioConfig()!;
        const http = vi.fn(async () => json({ error: 'unauthorized' }, 401));
        await expect(callStudioTool(config, 'auth.whoami', {}, { fetch: http })).rejects.toThrow('no longer accepts');
        expect(f.account.status()).toMatchObject({ connected: false, reason: expect.stringMatching(/revoked or expired/) });
        expect(f.vault.clear).toHaveBeenCalled();
    });
});

describe('identity for display', () => {
    it('reads the username and workspace name whatever the nesting', () => {
        expect(parseDesktopIdentity({ user: { username: 'ada', email: 'a@x.test' }, workspace: { name: 'Main' } }))
            .toEqual({ username: 'ada', email: 'a@x.test', workspaceName: 'Main' });
        expect(parseDesktopIdentity({ data: { username: 'ada', workspace_name: 'Main' } })).toEqual({ username: 'ada', workspaceName: 'Main' });
        expect(parseDesktopIdentity(null)).toEqual({});
    });
    it('saves the identity with the connection, keeps it across a refresh, and shows it after a restart without a network call', async () => {
        const f = fixture();
        f.http.mockImplementation(async (url: string) => (String(url).endsWith('/api/auth/desktop/me')
            ? json({ user: { username: 'ada' }, workspace: { id: 8, name: 'Main' } }) : json(token())));
        await f.account.connect();
        await f.account.identity();
        expect(f.account.status().identity).toEqual({ username: 'ada', workspaceName: 'Main' });
        const saved = f.vault.save.mock.calls.at(-1)![0] as StoredDesktopGrant;
        expect(saved).toMatchObject({ refreshToken: token().refresh_token, identity: { username: 'ada' } });

        let clock = 0;
        const g = fixture({ now: () => clock });
        g.vault.load.mockResolvedValue(saved);
        await g.account.restore();
        expect(g.account.status().identity).toEqual({ username: 'ada', workspaceName: 'Main' });
        expect(g.http).not.toHaveBeenCalled();
        g.http.mockImplementation(async () => json(token('b')));
        clock = 1;
        await g.account.accessToken();
        expect(g.vault.save).toHaveBeenLastCalledWith({ ...grant('b'), identity: { username: 'ada', workspaceName: 'Main' } });
    });
    it('never writes back an old refresh token when an identity answer lands after a rotation', async () => {
        let clock = 0;
        const f = fixture({ now: () => clock });
        let releaseMe!: () => void;
        const meGate = new Promise<void>(resolve => { releaseMe = resolve; });
        f.http.mockImplementation(async (url: string) => {
            if (String(url).endsWith('/api/auth/desktop/me')) { await meGate; return json({ user: { username: 'ada' } }); }
            return json(token(clock === 0 ? 'a' : 'b'));
        });
        await f.account.connect();
        const identity = f.account.identity();
        await new Promise(r => setTimeout(r, 5));
        clock = 900_000;
        await f.account.accessToken(); // rotates a -> b while the identity answer is pending
        releaseMe();
        await identity;
        const last = f.vault.save.mock.calls.at(-1)![0] as StoredDesktopGrant;
        expect(last.refreshToken).toBe(token('b').refresh_token);
    });
});

describe('development key-file vault and the vault choice', () => {
    it('keeps the grant encrypted in the key file and forgets it', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'scratchbox-keyfile-test-'));
        directories.push(dir);
        const filePath = join(dir, 'credentials.json');
        const vault = new KeyFileDesktopVault(new FileKeyStore({ filePath }));
        expect(await vault.load()).toBeNull();
        await vault.save(grant());
        expect((await readFile(filePath)).toString()).not.toContain(grant().refreshToken);
        expect(await vault.load()).toEqual(grant());
        await vault.clear();
        expect(await vault.load()).toBeNull();
    });
    it('uses the keychain when given, refuses inside Electron without it, and the key file only outside Electron', () => {
        const keychain = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v), decryptString: (b: Buffer) => b.toString() };
        expect(createDesktopVault({ encryption: keychain, dataDir: '/tmp/x' })).toBeInstanceOf(EncryptedDesktopVault);
        const inApp = createDesktopVault({ inElectron: true, dataDir: '/tmp/x' });
        expect(inApp).toBeInstanceOf(EncryptedDesktopVault);
        expect(() => inApp.assertAvailable()).toThrow('Secure OS');
        expect(createDesktopVault({ inElectron: false })).toBeInstanceOf(KeyFileDesktopVault);
    });
});

describe('encrypted native credential vault', () => {
    it.each(['basic_text', ''])('refuses a Linux plaintext or missing backend %s', backend => {
        const vault = new EncryptedDesktopVault('/unused', {
            isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend,
            encryptString: () => Buffer.alloc(0), decryptString: () => '',
        }, 'linux');
        expect(() => vault.assertAvailable()).toThrow('Secure OS');
    });
    it('atomically persists encrypted bytes with private file permissions and supports deletion', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'scratchbox-vault-test-'));
        directories.push(dir);
        const filename = join(dir, 'account', 'session.enc');
        // An injected stand-in proves wiring only, NOT the real OS keychain.
        const vault = new EncryptedDesktopVault(filename, {
            isEncryptionAvailable: () => true,
            encryptString: value => Buffer.from(Buffer.from(value).toString('base64')),
            decryptString: value => Buffer.from(value.toString(), 'base64').toString(),
        }, 'darwin');
        expect(await vault.load()).toBeNull();
        await vault.save(grant());
        expect((await readFile(filename)).toString()).not.toContain(grant().refreshToken);
        expect((await stat(filename)).mode & 0o777).toBe(0o600);
        expect(await vault.load()).toEqual(grant());
        await vault.clear();
        expect(await vault.load()).toBeNull();
    });
});
