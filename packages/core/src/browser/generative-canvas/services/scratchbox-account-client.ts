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
 * sign-in or sign-out. No token reaches the UI: the server keeps them and reports only the connection's status.
 */

import * as React from 'react';

export interface AccountStatusView {
    connected: boolean;
    connecting: boolean;
    origin: string;
    workspaceId: number | null;
    connectionId: number | null;
    identity?: { username?: string; email?: string; tier?: string; workspaceName?: string };
    reason?: string;
}

/** The name to show for a connected account (its username, else the workspace). */
export function accountDisplayName(status: AccountStatusView | undefined): string | undefined {
    if (!status?.connected) return undefined;
    return status.identity?.username ?? (status.identity?.workspaceName ? status.identity.workspaceName : undefined);
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
    publish(body.status as AccountStatusView);
    const url = String(body.url);
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
    return url;
}

export async function cancelAccountSignIn(): Promise<void> {
    const body = await readJson(await fetch('/api/account/cancel', { method: 'POST' }));
    publish(body.status as AccountStatusView);
}

export async function signOutOfAccount(): Promise<{ revoked: boolean }> {
    const body = await readJson(await fetch('/api/account/sign-out', { method: 'POST' }));
    publish(body.status as AccountStatusView);
    return { revoked: body.revoked === true };
}

/** Polls while the sign-in is in progress (the user finishes in their browser); returns the settled status. */
export async function waitForAccountSignIn(timeoutMs = 6 * 60_000, intervalMs = 1500, isCancelled: () => boolean = () => false): Promise<AccountStatusView | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !isCancelled()) {
        const status = await refreshAccountStatus();
        if (!status || status.connected || !status.connecting) return status;
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
