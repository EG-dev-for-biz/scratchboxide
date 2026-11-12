/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Sign in with scratchbox.ai end to end over real HTTP: the server's /api/account and /api/studio routes on Express, a
 * real DesktopAccount with the development key-file vault in a temporary file, and the local scratchbox.ai stand-in
 * (scripts/dev/scratchbox-ai-standin.cjs). The "browser" reads the consent page and follows its Approve link to the
 * account's loopback listener. Checks the status never carries a token, the hosted tools and signed media through the
 * connection, a refresh that rotates, a revoke from the web, and sign-out revoking on the stand-in.
 */

import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccountRouter, createStudioRouter } from '../server/routes/accountRoutes';
import type { RouteContext } from '../server/routes/types';
import { FileKeyStore } from '../../packages/core/src/node/key-store';
import { DesktopAccount } from '../../packages/core/src/node/scratchbox-account/desktop-account';
import { KeyFileDesktopVault } from '../../packages/core/src/node/scratchbox-account/desktop-vault';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStandin } = require('../../scripts/dev/scratchbox-ai-standin.cjs');

let standin: any, web = '', ide: http.Server, ideBase = '', tmp = '', credentialsFile = '';
let account: DesktopAccount;

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-account-routes-'));
    credentialsFile = path.join(tmp, 'credentials.json');
    standin = createStandin();
    web = await standin.listen();
    account = new DesktopAccount({ origin: web, vault: new KeyFileDesktopVault(new FileKeyStore({ filePath: credentialsFile })), device: 'test-mac', callbackTimeoutMs: 10_000 });
    const ctx = { sendError: (res: express.Response, err: unknown) => { res.status(500).json({ success: false, error: String(err) }); } } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use('/api/account', createAccountRouter(ctx, () => account));
    app.use('/api/studio', createStudioRouter(() => account));
    ide = http.createServer(app);
    await new Promise<void>(r => ide.listen(0, '127.0.0.1', () => r()));
    ideBase = `http://127.0.0.1:${(ide.address() as { port: number }).port}`;
});

afterAll(async () => {
    account.close();
    await new Promise<void>(r => ide.close(() => r()));
    await standin.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const status = async () => (await (await fetch(`${ideBase}/api/account/status`)).json()).status;

/** The user's browser: open the consent page and click Approve (or Deny). */
async function approve(consentUrl: string, choice: 'approve' | 'deny' = 'approve'): Promise<string> {
    const page = await (await fetch(consentUrl)).text();
    const href = page.match(new RegExp(`id="${choice}"[^>]*href="([^"]+)"`))![1].replace(/&#38;/g, '&');
    return (await fetch(href)).text();
}

async function until(check: () => Promise<boolean>, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 25)); }
    throw new Error(`timed out; status ${JSON.stringify(await status())}; stand-in events ${JSON.stringify(standin.events)}`);
}

async function signIn() {
    const started = await (await fetch(`${ideBase}/api/account/sign-in`, { method: 'POST' })).json();
    expect(started.success).toBe(true);
    const html = await approve(started.url);
    await until(async () => (await status()).connected === true);
    return { started, html };
}

describe('Sign in with scratchbox.ai through the server routes', () => {
    it('connects through the consent page, never shows a token, uses the hosted tools and media, and signs out with a revoke', async () => {
        expect(await status()).toMatchObject({ connected: false, connecting: false, origin: web });

        const { started, html } = await signIn();
        const consent = new URL(started.url);
        expect(`${consent.origin}${consent.pathname}`).toBe(`${web}/connect/desktop`);
        expect(consent.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/scratchbox\/callback$/);
        expect(consent.searchParams.get('device')).toBe('test-mac');
        expect(html).toContain('Return to Scratchbox IDE');

        await until(async () => !!(await status()).identity);
        const statusText = await (await fetch(`${ideBase}/api/account/status`)).text();
        expect(JSON.parse(statusText).status).toMatchObject({ connected: true, workspaceId: 217, identity: { username: 'standin-user', workspaceName: 'Stand-in Studio' } });
        expect(statusText).not.toMatch(/sbmcp_|sbdr_/);
        expect(fs.readFileSync(credentialsFile, 'utf8')).not.toMatch(/sbdr_|sbmcp_/);

        const tools = await (await fetch(`${ideBase}/api/studio/tools`)).json();
        expect(tools.tools.map((t: { name: string }) => t.name)).toContain('auth.whoami');
        const who = await (await fetch(`${ideBase}/api/studio/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'auth.whoami', arguments: {} }) })).json();
        expect(who).toEqual({ user: 'standin-user', workspaceId: 217 });
        const unknown = await fetch(`${ideBase}/api/studio/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'nope', arguments: {} }) });
        expect(unknown.status).toBe(502);
        expect((await unknown.json()).error).toMatch(/Tool nope not found/);

        const media = await (await fetch(`${ideBase}/api/studio/media`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storagePath: 'uploads/workspaces/217/image/a.jpg' }) })).json();
        expect(media.url).toMatch(new RegExp(`^${web}/signed/`));
        const bytes = Buffer.from(await (await fetch(media.url)).arrayBuffer());
        expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

        // an expired access token is renewed once, with the refresh token rotated
        standin.expireAccess();
        expect((await (await fetch(`${ideBase}/api/studio/tools`)).json()).tools).toBeDefined();
        expect(standin.events.filter((e: { event: string }) => e.event === 'refreshed')).toHaveLength(1);

        const out = await (await fetch(`${ideBase}/api/account/sign-out`, { method: 'POST' })).json();
        expect(out).toMatchObject({ success: true, revoked: true, status: { connected: false } });
        expect(standin.events.some((e: { event: string }) => e.event === 'revoked')).toBe(true);
        expect(fs.readFileSync(credentialsFile, 'utf8')).not.toContain('desktop-grant');
    });

    it('a declined consent leaves the IDE signed out', async () => {
        const started = await (await fetch(`${ideBase}/api/account/sign-in`, { method: 'POST' })).json();
        const html = await approve(started.url, 'deny');
        expect(html).toContain('declined');
        await until(async () => (await status()).connecting === false);
        expect((await status()).connected).toBe(false);
    });

    it('a second sign-in while one is pending is refused, and cancel stops the pending one', async () => {
        const first = await (await fetch(`${ideBase}/api/account/sign-in`, { method: 'POST' })).json();
        expect(first.success).toBe(true);
        const second = await fetch(`${ideBase}/api/account/sign-in`, { method: 'POST' });
        expect(second.status).toBe(409);
        expect((await second.json()).error).toMatch(/Finish or cancel/);
        const cancelled = await (await fetch(`${ideBase}/api/account/cancel`, { method: 'POST' })).json();
        expect(cancelled.status).toMatchObject({ connected: false, connecting: false });
    });

    it('a revoke from the web signs the IDE out on its next call, with the reason', async () => {
        await signIn();
        const connectionId = (await status()).connectionId;
        standin.revoke(connectionId);
        const call = await fetch(`${ideBase}/api/studio/tools`);
        expect(call.status).toBe(502);
        const after = await status();
        expect(after.connected).toBe(false);
        expect(after.reason).toMatch(/revoked or expired/);
    });

    it('the hosted tool routes refuse while nothing is connected', async () => {
        const res = await fetch(`${ideBase}/api/studio/tools`);
        expect(res.status).toBe(502);
        expect((await res.json()).error).toMatch(/not connected/);
    });
});
