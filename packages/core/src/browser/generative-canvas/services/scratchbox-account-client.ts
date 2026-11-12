/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The UI's view of Sign in with scratchbox.ai (the server's `/api/account`, desktop-app/server/routes/accountRoutes.ts).
 * One status shared by every component that shows it (Settings > Account, the sidebar's name), refreshed after a
 * sign-in or sign-out. The credential never reaches the UI: the server keeps it and reports only who and until when.
 */

import * as React from 'react';

export interface AccountStatusView {
    signedIn: boolean;
    baseUrl: string;
    user?: { id: string | number; username: string; email?: string; tier?: string };
    workspace?: { id: string | number; name: string };
    expiresAt?: string;
    expiresSoon?: boolean;
    reason?: string;
}

type Listener = (status: AccountStatusView | undefined) => void;

let current: AccountStatusView | undefined;
let inflight: Promise<AccountStatusView | undefined> | undefined;
const listeners = new Set<Listener>();

function publish(status: AccountStatusView | undefined): void {
    current = status;
    for (const l of listeners) l(status);
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.success === false) throw new Error(String(body?.error ?? `HTTP ${res.status}`));
    return body;
}

/** Reads the status from the server and shares it; a server without the account routes reads as signed out. */
export function refreshAccountStatus(): Promise<AccountStatusView | undefined> {
    inflight ??= fetch('/api/account/status', { cache: 'no-store' })
        .then(readJson)
        .then(body => { publish(body.status as AccountStatusView); return current; })
        .catch(() => { publish(undefined); return undefined; })
        .finally(() => { inflight = undefined; });
    return inflight;
}

/** Starts a sign-in: the server's consent URL opens in the system browser (Electron routes window.open there). */
export async function startAccountSignIn(): Promise<string> {
    const body = await readJson(await fetch('/api/account/sign-in', { method: 'POST' }));
    const url = String(body.url);
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
    return url;
}

export async function signOutOfAccount(): Promise<{ revoked: boolean }> {
    const body = await readJson(await fetch('/api/account/sign-out', { method: 'POST' }));
    publish(body.status as AccountStatusView);
    return { revoked: body.revoked === true };
}

/** Polls until the account reads signed in or `timeoutMs` passes (the user finishes in their browser). */
export async function waitForAccountSignIn(timeoutMs = 10 * 60_000, intervalMs = 2000, isCancelled: () => boolean = () => false): Promise<AccountStatusView | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !isCancelled()) {
        const status = await refreshAccountStatus();
        if (status?.signedIn) return status;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return current;
}

/** The shared account status; undefined until the first read (or when the server has no account routes). */
export function useScratchboxAccount(): AccountStatusView | undefined {
    const [status, setStatus] = React.useState<AccountStatusView | undefined>(current);
    React.useEffect(() => {
        listeners.add(setStatus);
        if (!current) void refreshAccountStatus();
        return () => { listeners.delete(setStatus); };
    }, []);
    return status;
}
