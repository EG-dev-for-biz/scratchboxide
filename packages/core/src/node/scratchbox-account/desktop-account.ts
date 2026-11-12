/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Sign in with scratchbox.ai: the IDE connects to one workspace the user approves in their browser.
 *
 * The flow is the authorization code grant with PKCE (S256) and a loopback redirect: a one-use callback listener on an
 * ephemeral port bound to 127.0.0.1 checks the exact Host, path and state (compared in constant time), refuses requests
 * that carry a browser Origin, and times out; a request with the wrong state never uses up the real attempt.
 * scratchbox.ai answers with a short-lived access token (`sbmcp_`, at most 15 minutes) and a refresh token (`sbdr_`) that
 * rotates on every use. Only the refresh token and the binding (origin, workspace, connection) are stored, in a vault
 * (desktop-vault.ts); access tokens live in memory. Refreshes are serialized, a refresh whose answer is uncertain is never
 * replayed (the user reconnects), and an epoch fences late answers so a cancelled or disconnected sign-in is never
 * restored. The server process holds all of it; the renderer sees status only.
 *
 * Contract (scratchbox.ai, `DESKTOP_CONNECT_ENABLED`): `GET /connect/desktop` (consent), `POST /api/auth/desktop/token`
 * (`grant_type` authorization_code or refresh_token), `GET`/`DELETE /api/auth/desktop/me` (identity, revoke this device),
 * `GET /api/auth/desktop/media?path=` (a signed URL for a workspace storage path).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { hostname } from 'node:os';
import type { StudioMcpConfig } from '../scratchbox-studio/studio-mcp-client';

const CLIENT = 'scratchbox-ide';
const SCOPE = 'workspace:read workspace:write';
export const ACCOUNT_CALLBACK_PATH = '/auth/scratchbox/callback';
export const DEFAULT_ACCOUNT_ORIGIN = 'https://www.scratchbox.ai';
const bytes = () => randomBytes(32).toString('base64url');
const fail = () => new Error('Scratchbox connection unavailable. Reconnect in Settings > Account.');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface StoredDesktopGrant {
    origin: string;
    workspaceId: number;
    connectionId: number;
    refreshToken: string;
    /** Who it is for (display only, from `/api/auth/desktop/me`), kept so a restart shows the name without a refresh. */
    identity?: DesktopIdentity;
}

/** Where the refresh token and binding are kept (desktop-vault.ts: the OS keychain in the app, a key file in development). */
export interface DesktopVault {
    /** Throws, with a message for the user, when the vault cannot store a credential securely right now. */
    assertAvailable(): void;
    load(): Promise<StoredDesktopGrant | null>;
    save(grant: StoredDesktopGrant): Promise<void>;
    clear(): Promise<void>;
}

interface TokenResponse {
    access_token: string; refresh_token: string; expires_in: number;
    workspace_id: number; connection_id: number; token_type: string; scope: string; mcp_path: string;
}

export interface DesktopAccountOptions {
    /** scratchbox.ai's origin: HTTPS, or plain HTTP only on a loopback host (a local stand-in). Never from the renderer. */
    origin: string;
    vault: DesktopVault;
    /** Opens the consent page; a call to connect() may pass its own (the server hands the URL to the UI instead). */
    openBrowser?(url: string): Promise<void>;
    fetch?: typeof fetch;
    now?: () => number;
    callbackTimeoutMs?: number;
    device?: string;
}

/** Who the connection is for, read from `GET /api/auth/desktop/me` (best effort, for display only). */
export interface DesktopIdentity {
    username?: string;
    email?: string;
    tier?: string;
    workspaceName?: string;
}

export interface DesktopAccountStatus {
    connected: boolean;
    connecting: boolean;
    origin: string;
    workspaceId: number | null;
    connectionId: number | null;
    identity?: DesktopIdentity;
    /** Why the IDE is not connected when it was before (refresh refused, revoked, keychain locked). */
    reason?: string;
}

/** The scratchbox.ai origin: SCRATCHBOX_ACCOUNT_URL (the process environment or secrets.json, never the renderer), else the official site. */
export function accountOrigin(env: Record<string, string | undefined> = process.env): string {
    return (env.SCRATCHBOX_ACCOUNT_URL?.trim() || DEFAULT_ACCOUNT_ORIGIN).replace(/\/+$/, '');
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined);

/** Reads the identity answer whatever its exact nesting (`{user, workspace}`, `{data: {...}}` or flat). */
export function parseDesktopIdentity(value: unknown): DesktopIdentity {
    const root = (value && typeof value === 'object' ? value : {}) as Record<string, any>;
    const body = root.data && typeof root.data === 'object' ? root.data : root;
    const user = body.user && typeof body.user === 'object' ? body.user : body;
    const workspace = body.workspace && typeof body.workspace === 'object' ? body.workspace : {};
    const out: DesktopIdentity = {};
    const username = str(user.username) ?? str(user.name) ?? str(body.username);
    const email = str(user.email);
    const tier = str(user.tier) ?? str(user.plan);
    const workspaceName = str(workspace.name) ?? str(body.workspace_name) ?? str(body.workspaceName);
    if (username) out.username = username;
    if (email) out.email = email;
    if (tier) out.tier = tier;
    if (workspaceName) out.workspaceName = workspaceName;
    return out;
}

/** The server's account. Never hand this object, its tokens or its vault to the renderer. */
export class DesktopAccount {
    readonly origin: string;
    private grant: StoredDesktopGrant | null = null;
    private access: { token: string; expiresAt: number } | null = null;
    private reason: string | undefined;
    private epoch = 0;
    private refreshPending: Promise<string> | null = null;
    private persistence: Promise<void> = Promise.resolve();
    private request?: AbortController;
    private cancelAttempt?: () => void;
    private connecting = false;
    private readonly http: typeof fetch;
    private readonly now: () => number;

    constructor(private readonly options: DesktopAccountOptions) {
        const origin = new URL(options.origin);
        const loopbackHttp = origin.protocol === 'http:' && LOOPBACK.has(origin.hostname);
        if ((origin.protocol !== 'https:' && !loopbackHttp) || origin.username || origin.password ||
            origin.pathname !== '/' || origin.search || origin.hash) {
            throw new Error('Scratchbox account origin must be an HTTPS origin (or HTTP on loopback) without a path or credentials.');
        }
        this.origin = origin.origin;
        this.http = options.fetch ?? globalThis.fetch;
        this.now = options.now ?? Date.now;
    }

    status(): DesktopAccountStatus {
        return {
            connected: !!this.grant, connecting: this.connecting, origin: this.origin,
            workspaceId: this.grant?.workspaceId ?? null,
            connectionId: this.grant?.connectionId ?? null,
            ...(this.grant?.identity ? { identity: this.grant.identity } : {}),
            ...(!this.grant && this.reason ? { reason: this.reason } : {}),
        };
    }

    /** Loads the saved connection (no network: the first call that needs a token refreshes it). */
    async restore(): Promise<void> {
        const epoch = this.epoch;
        let grant: StoredDesktopGrant | null;
        try { grant = await this.options.vault.load(); }
        catch (error) { this.reason = error instanceof Error ? error.message : String(error); throw error; }
        this.check(epoch);
        if (!grant) return;
        if (grant.origin !== this.origin || !Number.isSafeInteger(grant.workspaceId) || grant.workspaceId <= 0 ||
            !Number.isSafeInteger(grant.connectionId) || grant.connectionId <= 0 ||
            !/^sbdr_[A-Za-z0-9_-]{43}$/.test(grant.refreshToken)) {
            await this.clearLocal('The saved scratchbox.ai connection was for another site or unreadable. Connect again.');
            throw fail();
        }
        this.grant = grant;
    }

    private check(epoch: number): void {
        if (epoch !== this.epoch) throw new Error('Scratchbox connection attempt was superseded.');
    }

    private persist(epoch: number, operation: () => Promise<void>): Promise<void> {
        const work = this.persistence.then(async () => { this.check(epoch); await operation(); });
        this.persistence = work.catch(() => undefined);
        return work;
    }

    private async clearLocal(reason?: string): Promise<void> {
        const epoch = ++this.epoch;
        this.cancelAttempt?.();
        this.request?.abort();
        this.grant = null;
        this.access = null;
        this.refreshPending = null;
        this.reason = reason;
        await this.persist(epoch, () => this.options.vault.clear());
    }

    /** Stops a sign-in in progress; an established connection is left alone. */
    async cancel(): Promise<void> { if (this.connecting) await this.clearLocal(); }

    /** Stops pending work on shutdown without deleting a settled saved sign-in. */
    close(): void {
        ++this.epoch;
        this.cancelAttempt?.();
        this.request?.abort();
    }

    /**
     * scratchbox.ai refused an access token (401: the call did not run). Renew once: true when a new token came (the
     * caller may retry that call once); when the renewal is refused too (revoked from the web), the connection is
     * forgotten with the reason and this answers false.
     */
    async tokenRefused(connectionId = this.grant?.connectionId): Promise<boolean> {
        if (!this.grant || connectionId !== this.grant.connectionId) return false;
        this.access = null;
        try {
            await this.accessToken(connectionId);
            return true;
        } catch {
            this.reason = 'scratchbox.ai no longer accepts this connection (revoked or expired). Connect again.';
            return false;
        }
    }

    private async json(path: string, init: RequestInit, epoch: number): Promise<unknown> {
        this.check(epoch);
        const controller = new AbortController();
        this.request = controller;
        const timer = setTimeout(() => controller.abort(), 30_000);
        try {
            const response = await this.http(`${this.origin}${path}`, {
                ...init, redirect: 'error', signal: controller.signal,
                headers: { Accept: 'application/json', ...init.headers },
            });
            this.check(epoch);
            // Auth answers are tiny: read a bounded stream, never an unbounded error body.
            const reader = response.body?.getReader();
            if (!reader) throw fail();
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > 64 * 1024) throw fail();
                    chunks.push(value);
                }
            } finally { await reader.cancel().catch(() => undefined); }
            this.check(epoch);
            if (!response.ok) throw fail();
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } finally {
            clearTimeout(timer);
            if (this.request === controller) this.request = undefined;
        }
    }

    private async acceptToken(value: unknown, epoch: number, expected?: StoredDesktopGrant): Promise<string> {
        const t = value as Partial<TokenResponse> | null;
        if (!t || t.token_type !== 'Bearer' || t.scope !== SCOPE || t.mcp_path !== '/api/mcp/canvas' ||
            typeof t.access_token !== 'string' || !/^sbmcp_[A-Za-z0-9_-]{43}$/.test(t.access_token) ||
            typeof t.refresh_token !== 'string' || !/^sbdr_[A-Za-z0-9_-]{43}$/.test(t.refresh_token) ||
            !Number.isInteger(t.expires_in) || t.expires_in! < 1 || t.expires_in! > 900 ||
            !Number.isSafeInteger(t.workspace_id) || t.workspace_id! <= 0 ||
            !Number.isSafeInteger(t.connection_id) || t.connection_id! <= 0 ||
            (expected && (t.workspace_id !== expected.workspaceId || t.connection_id !== expected.connectionId ||
                t.refresh_token === expected.refreshToken))) throw fail();
        const grant: StoredDesktopGrant = {
            origin: this.origin, workspaceId: t.workspace_id!, connectionId: t.connection_id!,
            refreshToken: t.refresh_token, ...(expected?.identity ? { identity: expected.identity } : {}),
        };
        const receivedAt = this.now();
        // The new grant becomes current inside the save queue, so a save queued after it (identity) sees the rotated token.
        await this.persist(epoch, async () => {
            await this.options.vault.save(grant);
            this.check(epoch);
            this.grant = grant;
        });
        this.check(epoch);
        this.reason = undefined;
        this.access = { token: t.access_token, expiresAt: receivedAt + t.expires_in! * 1000 };
        return t.access_token;
    }

    async accessToken(connectionId = this.grant?.connectionId): Promise<string> {
        if (!this.grant || connectionId !== this.grant.connectionId || this.connecting) throw fail();
        if (this.access && this.access.expiresAt > this.now() + 30_000) return this.access.token;
        if (this.refreshPending) return this.refreshPending;
        const epoch = this.epoch, grant = this.grant;
        const pending = (async () => {
            try {
                const value = await this.json('/api/auth/desktop/token', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client_id: CLIENT, grant_type: 'refresh_token', refresh_token: grant.refreshToken }),
                }, epoch);
                return await this.acceptToken(value, epoch, grant);
            } catch {
                if (epoch === this.epoch) await this.clearLocal('scratchbox.ai did not renew the connection (revoked, expired or unreachable mid-renewal). Connect again.');
                throw fail();
            }
        })();
        this.refreshPending = pending;
        try { return await pending; }
        finally { if (this.refreshPending === pending) this.refreshPending = null; }
    }

    /** The Studio MCP connection for this workspace; its token provider is fenced to this connection. */
    studioConfig(): StudioMcpConfig | undefined {
        const grant = this.grant;
        if (!grant || this.connecting) return undefined;
        return {
            endpoint: `${this.origin}/api/mcp/canvas`, workspaceId: String(grant.workspaceId),
            getAccessToken: () => this.accessToken(grant.connectionId),
            resolveMedia: reference => this.mediaUrl(reference, grant.connectionId),
            onCredentialRejected: () => this.tokenRefused(grant.connectionId),
        };
    }

    /** Who the connection is for (`GET /api/auth/desktop/me`); saved with the connection for the status. */
    async identity(): Promise<DesktopIdentity> {
        const epoch = this.epoch, token = await this.accessToken();
        const value = await this.json('/api/auth/desktop/me', { headers: { Authorization: `Bearer ${token}` } }, epoch);
        const identity = parseDesktopIdentity(value);
        const current = this.grant;
        if (current && Object.keys(identity).length) {
            // Inside the save queue, and only if no refresh rotated the token meanwhile (never write back an old refresh token).
            await this.persist(epoch, async () => {
                if (this.grant !== current) return;
                const next = { ...current, identity };
                await this.options.vault.save(next);
                this.grant = next;
            });
        }
        return identity;
    }

    async mediaUrl(reference: string, connectionId = this.grant?.connectionId): Promise<string> {
        let storagePath = reference;
        if (reference.startsWith('/') || /^https?:/.test(reference)) {
            const url = new URL(reference, this.origin);
            if ((url.protocol !== 'https:' && url.origin !== this.origin) || url.username || url.password || url.hash)
                throw new Error('Expected an authorized workspace storage path.');
            // Already-signed or public provider media is a capability an authorized tool returned: never attach the
            // account's token to it, and never follow a foreign cookie-only API proxy.
            if (url.origin !== this.origin && !url.pathname.startsWith('/api/')) return url.href;
            if (url.origin !== this.origin || url.pathname !== '/api/storage/serve')
                throw new Error('Expected an authorized workspace storage path.');
            storagePath = url.searchParams.get('path') ?? '';
        }
        const epoch = this.epoch, token = await this.accessToken(connectionId);
        const result = await this.json(`/api/auth/desktop/media?path=${encodeURIComponent(storagePath)}`, {
            headers: { Authorization: `Bearer ${token}` },
        }, epoch) as { url?: unknown };
        const url = new URL(typeof result.url === 'string' ? result.url : '');
        if ((url.protocol !== 'https:' && url.origin !== this.origin) || url.username || url.password) throw fail();
        return url.href; // fetched WITHOUT any Scratchbox authorization header
    }

    /** Revokes this device on scratchbox.ai, then forgets it here whatever the answer; returns whether the revoke was confirmed. */
    async disconnect(): Promise<{ revoked: boolean }> {
        if (this.connecting) {
            await this.cancel();
            return { revoked: false };
        }
        let revoked = false;
        const epoch = this.epoch;
        try {
            if (this.grant) {
                const token = await this.accessToken();
                await this.json('/api/auth/desktop/me', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }, epoch);
                revoked = true;
            } else revoked = true;
        } catch { /* always clear locally; never claim an unconfirmed revoke */ }
        if (epoch === this.epoch) await this.clearLocal();
        return { revoked };
    }

    /**
     * Connects one workspace: opens the consent page (through `openBrowser`) and waits for the browser to come back.
     * Resolves once the token is exchanged and stored; rejects with a fixed message (never the server's text) otherwise.
     */
    async connect(openBrowser = this.options.openBrowser): Promise<void> {
        if (this.connecting) throw new Error('Finish or cancel the current Scratchbox sign-in first.');
        if (this.grant) throw new Error('Disconnect the current workspace before connecting another one.');
        if (!openBrowser) throw new Error('Scratchbox sign-in has no way to open the browser.');
        this.options.vault.assertAvailable();
        const epoch = ++this.epoch;
        this.connecting = true;
        this.reason = undefined;
        const verifier = bytes(), state = bytes();
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        let server: Server | undefined, timer: ReturnType<typeof setTimeout> | undefined;
        let consumed = false, settled = false;
        let cancel: (() => void) | undefined;
        try {
            const callback = new Promise<string>((resolve, reject) => {
                server = createServer((req, res) => {
                    res.setHeader('Cache-Control', 'no-store');
                    res.setHeader('Referrer-Policy', 'no-referrer');
                    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
                    let url: URL;
                    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); }
                    catch { res.writeHead(400).end('Invalid Scratchbox callback.'); return; }
                    const address = server!.address();
                    const expectedHost = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : '';
                    const states = url.searchParams.getAll('state');
                    const match = states.length === 1 && Buffer.byteLength(states[0]) === Buffer.byteLength(state) &&
                        timingSafeEqual(Buffer.from(states[0]), Buffer.from(state));
                    if (req.method !== 'GET' || req.headers.host !== expectedHost || url.pathname !== ACCOUNT_CALLBACK_PATH || !match ||
                        req.headers.origin || consumed) {
                        res.writeHead(400).end('Invalid Scratchbox callback.');
                        return; // a hostile request must not use up the real attempt
                    }
                    const codes = url.searchParams.getAll('code'), errors = url.searchParams.getAll('error');
                    if ((errors.length === 1 && codes.length === 0) ||
                        (errors.length === 0 && codes.length === 1 && /^sbdc_[A-Za-z0-9_-]{43}$/.test(codes[0]))) {
                        consumed = true;
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(resultPage(errors.length > 0));
                        if (errors.length) reject(new Error('Scratchbox sign-in was declined.'));
                        else resolve(codes[0]);
                    } else res.writeHead(400).end('Invalid Scratchbox callback.');
                });
                cancel = () => reject(new Error('Scratchbox sign-in was cancelled.'));
                this.cancelAttempt = cancel;
                timer = setTimeout(() => reject(new Error('Scratchbox sign-in expired. Start a new connection.')),
                    this.options.callbackTimeoutMs ?? 300_000);
            });
            void callback.catch(() => undefined);
            await new Promise<void>((resolve, reject) => {
                server!.once('error', reject);
                server!.listen(0, '127.0.0.1', resolve);
            });
            this.check(epoch);
            const address = server!.address();
            if (!address || typeof address === 'string') throw fail();
            const redirect = `http://127.0.0.1:${address.port}${ACCOUNT_CALLBACK_PATH}`;
            const url = new URL('/connect/desktop', this.origin);
            url.search = new URLSearchParams({
                client_id: CLIENT, redirect_uri: redirect, state, code_challenge: challenge,
                code_challenge_method: 'S256', device: (this.options.device ?? hostname()).slice(0, 120),
            }).toString();
            await Promise.race([openBrowser(url.href), callback.then(() => undefined)]);
            const code = await callback;
            this.check(epoch);
            const result = await this.json('/api/auth/desktop/token', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ client_id: CLIENT, grant_type: 'authorization_code', code,
                    redirect_uri: redirect, code_verifier: verifier }),
            }, epoch);
            await this.acceptToken(result, epoch);
            settled = true;
        } catch (error) {
            if (epoch === this.epoch) await this.clearLocal();
            // Only our fixed messages reach the user, never the server's text or a request URL.
            if (error instanceof Error && /^(Scratchbox sign-in|Finish or cancel)/.test(error.message)) throw error;
            throw fail();
        } finally {
            clearTimeout(timer);
            cancel?.();
            server?.close();
            server?.closeAllConnections();
            if (this.cancelAttempt === cancel) {
                this.cancelAttempt = undefined;
                this.connecting = false;
            }
        }
        // The name for display, once connected (not part of connecting: a failure here changes nothing).
        if (settled) void this.identity().catch(() => undefined);
    }
}

function resultPage(declined: boolean): string {
    const title = declined ? 'Not connected' : 'Return to Scratchbox IDE';
    const body = declined ? 'The connection was declined. You can close this tab.' : 'Return to Scratchbox IDE to finish connecting. You can close this tab.';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>`
        + '<style>body{font-family:-apple-system,system-ui,sans-serif;background:#18181b;color:#f4f4f5;display:grid;place-items:center;min-height:100vh;margin:0}'
        + 'main{max-width:420px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 12px}p{color:#a1a1aa;line-height:1.5;margin:0}</style></head>'
        + `<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}
