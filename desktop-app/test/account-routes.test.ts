/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The account routes (accountRoutes.ts) on a real Express server: the sign-in URL's callback is this server's own port,
 * the status never carries the credential, and the open callback completes only a sign-in this server started, with
 * whatever it echoes HTML-escaped. scratchbox.ai is a local stand-in; nothing leaves the machine.
 */

import * as crypto from 'crypto';
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccountCallbackHandler, createAccountRouter } from '../server/routes/accountRoutes';
import type { RouteContext } from '../server/routes/types';
import { FileKeyStore } from '../../packages/core/src/node/key-store';
import { ACCOUNT_CALLBACK_PATH, ScratchboxAccount, pkceChallenge } from '../../packages/core/src/node/scratchbox-account/scratchbox-account';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let web: http.Server, ide: http.Server;
let webBase = '', ideBase = '', idePort = 0, tmp = '';
const issued = new Map<string, string>();
const live = new Set<string>();

const listen = (s: http.Server) => new Promise<number>(r => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-account-routes-'));
    web = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            res.setHeader('content-type', 'application/json');
            if (req.url === '/api/auth/desktop/token') {
                const body = JSON.parse(raw);
                const challenge = issued.get(body.code);
                if (!challenge || pkceChallenge(body.code_verifier) !== challenge) { res.statusCode = 400; res.end('{"success":false,"error":"invalid_grant"}'); return; }
                const credential = `sbmcp_${b64url(crypto.randomBytes(32))}`;
                live.add(credential);
                res.end(JSON.stringify({ success: true, data: { credential, expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(), user: { id: 7, username: '<b>ada</b>' }, workspace: { id: 3, name: 'Main' } } }));
                return;
            }
            if (req.url === '/api/auth/desktop/revoke') { const ok = live.delete(String(req.headers.authorization).slice(7)); res.statusCode = ok ? 200 : 401; res.end('{}'); return; }
            res.statusCode = 404; res.end('{}');
        });
    });
    webBase = `http://127.0.0.1:${await listen(web)}`;

    const account = new ScratchboxAccount({ store: new FileKeyStore({ filePath: path.join(tmp, 'credentials.json') }), env: { SCRATCHBOX_ACCOUNT_URL: webBase } });
    const ctx = { sendError: (res: express.Response, err: unknown) => { res.status(500).json({ success: false, error: String(err) }); } } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use('/api/account', createAccountRouter(ctx, account));
    app.get(ACCOUNT_CALLBACK_PATH, createAccountCallbackHandler(account));
    ide = http.createServer(app);
    idePort = await listen(ide);
    ideBase = `http://127.0.0.1:${idePort}`;
});

afterAll(async () => {
    await new Promise<void>(r => web.close(() => r()));
    await new Promise<void>(r => ide.close(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('account routes', () => {
    it('signs in through the callback, reports the status without the credential, and signs out', async () => {
        expect((await (await fetch(`${ideBase}/api/account/status`)).json()).status.signedIn).toBe(false);

        const started = await (await fetch(`${ideBase}/api/account/sign-in`, { method: 'POST' })).json();
        const u = new URL(started.url);
        expect(u.origin).toBe(webBase);
        expect(u.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${idePort}${ACCOUNT_CALLBACK_PATH}`);

        // The consent page approves and the browser goes back to the redirect URI.
        const code = b64url(crypto.randomBytes(16));
        issued.set(code, u.searchParams.get('code_challenge')!);
        const back = new URL(u.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', u.searchParams.get('state')!);
        const page = await fetch(back);
        const html = await page.text();
        expect(page.status).toBe(200);
        expect(page.headers.get('cache-control')).toBe('no-store');
        expect(html).toContain('Signed in to Scratchbox IDE');
        expect(html).toContain('&lt;b&gt;ada&lt;/b&gt;');
        expect(html).not.toContain('<b>ada</b>');

        const statusRes = await fetch(`${ideBase}/api/account/status`);
        const statusText = await statusRes.text();
        expect(JSON.parse(statusText).status).toMatchObject({ signedIn: true, workspace: { id: 3, name: 'Main' } });
        expect(statusText).not.toMatch(/sbmcp_/);
        expect(live.size).toBe(1);

        const out = await (await fetch(`${ideBase}/api/account/sign-out`, { method: 'POST' })).json();
        expect(out).toMatchObject({ success: true, revoked: true, status: { signedIn: false } });
        expect(live.size).toBe(0);
    });

    it('answers a callback it did not start with a plain refusal page', async () => {
        const res = await fetch(`${ideBase}${ACCOUNT_CALLBACK_PATH}?code=abc&state=%3Cscript%3E`);
        const html = await res.text();
        expect(res.status).toBe(400);
        expect(html).toContain('Not signed in');
        expect(html).not.toContain('<script>');
    });
});
