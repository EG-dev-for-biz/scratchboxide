#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A local stand-in for scratchbox.ai's desktop connection (packages/core/src/node/scratchbox-account/desktop-account.ts),
 * for tests and for checking Sign in with scratchbox.ai in the running app without production:
 *
 *   node scripts/dev/scratchbox-ai-standin.cjs [port] [--auto-approve]
 *   SCRATCHBOX_ACCOUNT_URL=http://127.0.0.1:<port> SCRATCHBOX_CREDENTIALS_FILE=<scratch file> npm run dev
 *
 * It implements the contract the IDE speaks: the consent page (an explicit Approve or Deny; `--auto-approve` approves
 * after 2 s, for a browser that cannot be clicked), the token endpoint (authorization code with the PKCE verifier and
 * redirect URI checked; refresh tokens that rotate and are refused on reuse), identity and revoke at /api/auth/desktop/me,
 * signed media, and an MCP route answering tools/list and tools/call that refuses a revoked or expired token with 401.
 * Everything is in memory; the tokens it issues are random and worthless anywhere else.
 */

const http = require('http');
const crypto = require('crypto');

const b64url = buf => buf.toString('base64url');
const token = prefix => `${prefix}${b64url(crypto.randomBytes(32))}`; // 43 characters after the prefix
const SCOPE = 'workspace:read workspace:write';

function createStandin(options = {}) {
    const workspace = options.workspace ?? { id: 217, name: 'Stand-in Studio' };
    const user = options.user ?? { id: 7, username: 'standin-user', email: 'standin@example.test', tier: 'pro' };
    const accessTtl = options.accessTtlSeconds ?? 600;
    const log = options.log ?? (() => undefined);
    const codes = new Map();      // code -> { challenge, redirect }
    const refresh = new Map();    // refresh token -> connection id (deleted on use: rotation)
    const access = new Map();     // access token -> { connectionId, expiresAt }
    const connections = new Map(); // connection id -> { revoked }
    const events = [];
    let nextConnection = 1;
    const note = (event, detail = {}) => { events.push({ event, ...detail }); log(event, detail); };

    function issue(connectionId) {
        const a = token('sbmcp_'), r = token('sbdr_');
        access.set(a, { connectionId, expiresAt: Date.now() + accessTtl * 1000 });
        refresh.set(r, connectionId);
        return { access_token: a, refresh_token: r, token_type: 'Bearer', expires_in: accessTtl, scope: SCOPE,
            workspace_id: workspace.id, connection_id: connectionId, mcp_path: '/api/mcp/canvas' };
    }
    function bearer(req) {
        const auth = String(req.headers.authorization || '');
        const t = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const a = access.get(t);
        if (!a || a.expiresAt < Date.now() || connections.get(a.connectionId)?.revoked) return undefined;
        return a;
    }
    const send = (res, status, body, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        let raw = '';
        req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
        req.on('end', () => {
            if (req.method === 'GET' && u.pathname === '/connect/desktop') {
                const q = u.searchParams, redirect = q.get('redirect_uri') || '';
                if (q.get('client_id') !== 'scratchbox-ide' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state') ||
                    !/^http:\/\/127\.0\.0\.1:\d+\/auth\/scratchbox\/callback$/.test(redirect)) return send(res, 400, 'bad request', 'text/plain');
                const code = token('sbdc_');
                codes.set(code, { challenge: q.get('code_challenge'), redirect });
                const ok = new URL(redirect); ok.searchParams.set('state', q.get('state')); ok.searchParams.set('code', code);
                const no = new URL(redirect); no.searchParams.set('state', q.get('state')); no.searchParams.set('error', 'access_denied');
                note('consent', { device: q.get('device') });
                const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
                const refreshTag = options.autoApprove ? `<meta http-equiv="refresh" content="2;url=${esc(ok)}">` : '';
                return send(res, 200, `<!doctype html><meta charset="utf-8">${refreshTag}<title>Stand-in consent</title>`
                    + '<body style="font-family:system-ui;background:#111;color:#eee;padding:40px"><h2>Stand-in scratchbox.ai</h2>'
                    + `<p>Connect Scratchbox IDE on ${esc(q.get('device'))} to the workspace "${esc(workspace.name)}" (read and write)?${options.autoApprove ? ' Approving in 2 s (test stand-in).' : ''}</p>`
                    + `<a id="approve" style="color:#8cf" href="${esc(ok)}">Approve</a> &nbsp; <a id="deny" style="color:#f88" href="${esc(no)}">Deny</a></body>`, 'text/html');
            }
            if (req.method === 'POST' && u.pathname === '/api/auth/desktop/token') {
                let body;
                try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid_request' }); }
                if (body.client_id !== 'scratchbox-ide') return send(res, 400, { error: 'invalid_client' });
                if (body.grant_type === 'authorization_code') {
                    const grant = codes.get(body.code); codes.delete(body.code);
                    const challenge = b64url(crypto.createHash('sha256').update(String(body.code_verifier)).digest());
                    if (!grant || grant.redirect !== body.redirect_uri || grant.challenge !== challenge) { note('token-refused'); return send(res, 400, { error: 'invalid_grant' }); }
                    const id = nextConnection++;
                    connections.set(id, { revoked: false });
                    note('token-issued', { connectionId: id });
                    return send(res, 200, issue(id));
                }
                if (body.grant_type === 'refresh_token') {
                    const id = refresh.get(body.refresh_token);
                    refresh.delete(body.refresh_token);
                    if (!id || connections.get(id)?.revoked) { note('refresh-refused'); return send(res, 400, { error: 'invalid_grant' }); }
                    note('refreshed', { connectionId: id });
                    return send(res, 200, issue(id));
                }
                return send(res, 400, { error: 'unsupported_grant_type' });
            }
            if (u.pathname === '/api/auth/desktop/me') {
                const a = bearer(req);
                if (!a) return send(res, 401, { error: 'unauthorized' });
                if (req.method === 'DELETE') { connections.get(a.connectionId).revoked = true; note('revoked', { connectionId: a.connectionId }); return send(res, 200, { revoked: true }); }
                return send(res, 200, { user, workspace, connection_id: a.connectionId });
            }
            if (req.method === 'GET' && u.pathname === '/api/auth/desktop/media') {
                if (!bearer(req)) return send(res, 401, { error: 'unauthorized' });
                const path = u.searchParams.get('path') || '';
                if (!path.startsWith(`uploads/workspaces/${workspace.id}/`)) return send(res, 403, { error: 'forbidden' });
                return send(res, 200, { url: `http://127.0.0.1:${server.address().port}/signed/${encodeURIComponent(path)}?sig=${b64url(crypto.randomBytes(8))}` });
            }
            if (req.method === 'GET' && u.pathname.startsWith('/signed/')) {
                if (req.headers.authorization) return send(res, 400, { error: 'no authorization on signed media' });
                return send(res, 200, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]), 'image/jpeg');
            }
            if (req.method === 'POST' && u.pathname === '/api/mcp/canvas') {
                if (!bearer(req)) { note('mcp-refused'); return send(res, 401, { error: 'unauthorized' }); }
                let rpc;
                try { rpc = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid json' }); }
                const answer = result => send(res, 200, `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`, 'text/event-stream');
                if (rpc.method === 'tools/list') return answer({ tools: [{ name: 'auth.whoami' }, { name: 'canvas.list_nodes' }] });
                if (rpc.method === 'tools/call' && rpc.params?.name === 'auth.whoami') return answer({ content: [{ type: 'text', text: '' }], structuredContent: { user: user.username, workspaceId: workspace.id } });
                return answer({ content: [{ type: 'text', text: `Tool ${rpc.params?.name} not found` }], isError: true });
            }
            send(res, 404, { error: 'not found' });
        });
    });

    return {
        server, events, connections,
        listen: (port = 0) => new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
        close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
        /** Revoke a connection from "the web" (device settings). */
        revoke: id => { if (connections.has(id)) connections.get(id).revoked = true; },
        /** Expire every access token now (forces a refresh on the next call). */
        expireAccess: () => { for (const a of access.values()) a.expiresAt = 0; }
    };
}

module.exports = { createStandin };

if (require.main === module) {
    const port = Number(process.argv.find(a => /^\d+$/.test(a)) || 3175);
    const standin = createStandin({ autoApprove: process.argv.includes('--auto-approve'), log: (e, d) => console.log(new Date().toISOString(), e, JSON.stringify(d)) });
    standin.listen(port).then(url => console.log(`scratchbox.ai stand-in at ${url}`));
}
