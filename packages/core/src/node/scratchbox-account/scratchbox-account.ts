/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Sign in with scratchbox.ai (docs/research/2026-11-11-scratchbox-account-sign-in-plan.md, phase A): one account for the
 * IDE and the web. The browser does the signing in, on scratchbox.ai; the IDE never sees a password or a web session.
 *
 * OAuth 2.0 authorization code with PKCE and a loopback redirect (RFC 8252): `start` makes a `state` and a code verifier
 * and the URL of scratchbox.ai's consent page; the user allows the IDE for one workspace there; scratchbox.ai redirects
 * the browser to this server's callback with a one-time code; `complete` exchanges it, with the verifier, for one of
 * scratchbox.ai's per-workspace credentials (`sbmcp_…`, at most 90 days), kept in the key store with who and where it is
 * for. The browser UI only ever reads `status`.
 */

import * as crypto from 'crypto';
import * as os from 'os';
import { FileKeyStore, type KeyStore } from '../key-store';

/** Where the credential and the profile it belongs to are kept in the key store. */
export const ACCOUNT_KEYS = { service: 'scratchbox.ai', credential: 'credential', profile: 'profile' } as const;
export const DEFAULT_ACCOUNT_URL = 'https://www.scratchbox.ai';
/** The browser's way back to this server (RFC 8252 loopback redirect); also an open route on the launch-token gate. */
export const ACCOUNT_CALLBACK_PATH = '/auth/scratchbox/callback';
/** How long a started sign-in waits for the browser to come back. */
export const PENDING_SIGN_IN_MS = 10 * 60 * 1000;
/** The IDE asks the user to reconnect this long before the credential expires. */
export const RECONNECT_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

const CREDENTIAL_SHAPE = /^sbmcp_[A-Za-z0-9_-]{43}$/;

export class AccountError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = 'AccountError';
    }
}

export interface ScratchboxProfile {
    user: { id: number; username: string; email?: string; tier?: string };
    workspace: { id: number; name: string };
    expiresAt: string;
    connectedAt: string;
    /** The scratchbox.ai the credential is for. */
    baseUrl: string;
}

export interface AccountStatus {
    signedIn: boolean;
    baseUrl: string;
    user?: ScratchboxProfile['user'];
    workspace?: ScratchboxProfile['workspace'];
    expiresAt?: string;
    /** Inside the reconnect warning. */
    expiresSoon?: boolean;
    /** Why the IDE is signed out when it was signed in before (expired, revoked). */
    reason?: string;
}

export interface AccountCredential {
    token: string;
    workspaceId: number;
    baseUrl: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export function accountBaseUrl(env: Record<string, string | undefined> = process.env): string {
    return (env.SCRATCHBOX_ACCOUNT_URL?.trim() || DEFAULT_ACCOUNT_URL).replace(/\/+$/, '');
}

const base64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PKCE's S256 challenge of a verifier (RFC 7636): base64url(sha256(verifier)). */
export function pkceChallenge(verifier: string): string {
    return base64url(crypto.createHash('sha256').update(verifier).digest());
}

/** A fresh PKCE pair: a 43-character verifier from 32 random bytes, and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
    const verifier = base64url(crypto.randomBytes(32));
    return { verifier, challenge: pkceChallenge(verifier) };
}

export function loopbackRedirectUri(port: number): string {
    return `http://127.0.0.1:${port}${ACCOUNT_CALLBACK_PATH}`;
}

function parseProfile(text: string | undefined): ScratchboxProfile | undefined {
    if (!text) return undefined;
    try {
        const p = JSON.parse(text) as ScratchboxProfile;
        return p && p.user && p.workspace && typeof p.expiresAt === 'string' ? p : undefined;
    } catch {
        return undefined;
    }
}

export class ScratchboxAccount {
    private readonly store: KeyStore;
    private readonly fetchFn: FetchLike;
    private readonly env: Record<string, string | undefined>;
    private readonly now: () => number;
    private readonly pending = new Map<string, { verifier: string; redirectUri: string; device: string; at: number }>();
    private lastReason: string | undefined;

    constructor(options: { store?: KeyStore; fetch?: FetchLike; env?: Record<string, string | undefined>; now?: () => number } = {}) {
        this.store = options.store ?? new FileKeyStore();
        this.fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
        this.env = options.env ?? process.env;
        this.now = options.now ?? Date.now;
    }

    get baseUrl(): string {
        return accountBaseUrl(this.env);
    }

    /** Starts a sign-in: the URL of scratchbox.ai's consent page for this server's callback on `port`. */
    start(args: { port: number; device?: string }): { url: string; state: string } {
        if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) throw new AccountError('invalid_request', 'The callback port is not a port number.');
        const t = this.now();
        for (const [s, p] of this.pending) if (t - p.at > PENDING_SIGN_IN_MS) this.pending.delete(s);
        const state = base64url(crypto.randomBytes(24));
        const { verifier, challenge } = pkcePair();
        const redirectUri = loopbackRedirectUri(args.port);
        const device = (args.device ?? os.hostname()).slice(0, 60);
        this.pending.set(state, { verifier, redirectUri, device, at: t });
        const q = new URLSearchParams({
            client_id: 'scratchbox-ide',
            redirect_uri: redirectUri,
            state,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            device
        });
        return { url: `${this.baseUrl}/connect/desktop?${q.toString()}`, state };
    }

    /**
     * Completes a sign-in from the browser's return to the callback: the state must be one this server started (and is
     * used up), then the code is exchanged with the verifier for the credential, which is kept with its profile.
     */
    async complete(query: { code?: string; state?: string; error?: string }): Promise<ScratchboxProfile> {
        const pending = query.state ? this.pending.get(query.state) : undefined;
        if (!query.state || !pending) throw new AccountError('invalid_state', 'This sign-in was not started here, or it is more than 10 minutes old. Start it again from the IDE.');
        this.pending.delete(query.state);
        if (this.now() - pending.at > PENDING_SIGN_IN_MS) throw new AccountError('invalid_state', 'This sign-in took more than 10 minutes. Start it again from the IDE.');
        if (query.error) throw new AccountError(query.error, query.error === 'access_denied' ? 'The sign-in was declined on scratchbox.ai.' : `scratchbox.ai did not sign the IDE in (${query.error}).`);
        if (!query.code) throw new AccountError('invalid_request', 'scratchbox.ai sent no code back.');
        const res = await this.fetchFn(`${this.baseUrl}/api/auth/desktop/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ code: query.code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri })
        });
        const text = await res.text();
        let body: any;
        try { body = JSON.parse(text); } catch { body = undefined; }
        const data = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : body;
        if (!res.ok) throw new AccountError(String(data?.error ?? `http_${res.status}`), `scratchbox.ai refused the sign-in (HTTP ${res.status}${data?.error ? `: ${data.error}` : ''}).`);
        if (!data || !CREDENTIAL_SHAPE.test(String(data.credential)) || !data.user || !data.workspace || typeof data.expiresAt !== 'string') {
            throw new AccountError('invalid_response', 'scratchbox.ai answered the sign-in without a credential the IDE can use.');
        }
        const profile: ScratchboxProfile = {
            user: { id: Number(data.user.id), username: String(data.user.username), ...(data.user.email ? { email: String(data.user.email) } : {}), ...(data.user.tier ? { tier: String(data.user.tier) } : {}) },
            workspace: { id: Number(data.workspace.id), name: String(data.workspace.name) },
            expiresAt: new Date(data.expiresAt).toISOString(),
            connectedAt: new Date(this.now()).toISOString(),
            baseUrl: this.baseUrl
        };
        await this.store.setPassword(ACCOUNT_KEYS.service, ACCOUNT_KEYS.credential, String(data.credential));
        await this.store.setPassword(ACCOUNT_KEYS.service, ACCOUNT_KEYS.profile, JSON.stringify(profile));
        this.lastReason = undefined;
        return profile;
    }

    /** Who the IDE is signed in as, for the UI (never the credential). An expired credential reads as signed out. */
    async status(): Promise<AccountStatus> {
        const profile = parseProfile(await this.store.getPassword(ACCOUNT_KEYS.service, ACCOUNT_KEYS.profile));
        const hasCredential = !!(await this.store.getPassword(ACCOUNT_KEYS.service, ACCOUNT_KEYS.credential));
        if (!profile || !hasCredential) return { signedIn: false, baseUrl: this.baseUrl, ...(this.lastReason ? { reason: this.lastReason } : {}) };
        const left = Date.parse(profile.expiresAt) - this.now();
        if (!(left > 0)) return { signedIn: false, baseUrl: profile.baseUrl, reason: 'The scratchbox.ai sign-in expired. Connect again.' };
        return { signedIn: true, baseUrl: profile.baseUrl, user: profile.user, workspace: profile.workspace, expiresAt: profile.expiresAt, expiresSoon: left < RECONNECT_WARNING_MS };
    }

    /** The credential for calls to scratchbox.ai, while signed in and unexpired. */
    async credential(): Promise<AccountCredential | undefined> {
        return this.credentialOf(await this.store.getPassword(ACCOUNT_KEYS.service, ACCOUNT_KEYS.credential), await this.store.getPassword(ACCOUNT_KEYS.service, ACCOUNT_KEYS.profile));
    }

    /** credential() for code that cannot await, when the key store reads synchronously (the file store does). */
    credentialSync(): AccountCredential | undefined {
        const sync = (this.store as Partial<Pick<FileKeyStore, 'getPasswordSync'>>).getPasswordSync;
        if (typeof sync !== 'function') return undefined;
        return this.credentialOf(sync.call(this.store, ACCOUNT_KEYS.service, ACCOUNT_KEYS.credential), sync.call(this.store, ACCOUNT_KEYS.service, ACCOUNT_KEYS.profile));
    }

    private credentialOf(token: string | undefined, profileText: string | undefined): AccountCredential | undefined {
        const profile = parseProfile(profileText);
        if (!token || !CREDENTIAL_SHAPE.test(token) || !profile || !(Date.parse(profile.expiresAt) > this.now())) return undefined;
        return { token, workspaceId: profile.workspace.id, baseUrl: profile.baseUrl };
    }

    /**
     * Signs out: asks scratchbox.ai to revoke the credential (it revokes only itself), then forgets it here whatever the
     * answer. Returns whether scratchbox.ai confirmed the revoke.
     */
    async signOut(): Promise<{ revoked: boolean }> {
        const cred = await this.credential();
        let revoked = false;
        if (cred) {
            try {
                const res = await this.fetchFn(`${cred.baseUrl}/api/auth/desktop/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${cred.token}`, Accept: 'application/json' } });
                revoked = res.ok;
            } catch {
                revoked = false;
            }
        }
        await this.forget();
        return { revoked };
    }

    /** scratchbox.ai refused the credential (revoked from the web, or expired there): forget it, with the reason. */
    async rejected(reason = 'scratchbox.ai no longer accepts this sign-in (revoked or expired). Connect again.'): Promise<void> {
        await this.forget();
        this.lastReason = reason;
    }

    private async forget(): Promise<void> {
        await this.store.deletePassword(ACCOUNT_KEYS.service, ACCOUNT_KEYS.credential);
        await this.store.deletePassword(ACCOUNT_KEYS.service, ACCOUNT_KEYS.profile);
    }
}

let shared: ScratchboxAccount | undefined;

/** The server's one account (its pending sign-ins live in memory, so start and callback must share it). */
export function getScratchboxAccount(): ScratchboxAccount {
    shared ??= new ScratchboxAccount();
    return shared;
}
