/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Client-side configuration for talking to the Scratchbox API.
 *
 * The API requires a per-launch token. Under Electron the preload exposes it as
 * `window.scratchbox.launchToken`; under the Vite dev server the proxy injects
 * it server-side, so the helpers below are a no-op safety net there.
 *
 * This module is compiled into both the renderer and the node/electron builds
 * (via `common.ts`), so it must not reference DOM lib types directly.
 */

export const API_TOKEN_HEADER = 'X-Scratchbox-Token';

/** URL prefixes that belong to the authenticated Scratchbox API. */
export const API_PATH_PREFIXES = ['/gemini', '/workspace', '/media', '/api/'];

interface ScratchboxWindowConfig {
    launchToken?: string;
    apiBase?: string;
}

interface HostGlobal {
    scratchbox?: ScratchboxWindowConfig;
    scratchboxDesktop?: { getLaunchToken?: () => unknown };
    location?: { href: string; origin: string };
    fetch?: (...args: any[]) => Promise<any>;
    EventSource?: any;
    Headers?: any;
    Request?: any;
}

/** The renderer `window` when present; undefined under node. */
function hostWindow(): HostGlobal | undefined {
    const g = globalThis as unknown as HostGlobal & { window?: unknown; document?: unknown };
    return typeof g.window !== 'undefined' && typeof g.document !== 'undefined' ? g : undefined;
}

function windowConfig(): ScratchboxWindowConfig | undefined {
    const config = hostWindow()?.scratchbox;
    return config && typeof config === 'object' ? config : undefined;
}

let cachedToken: string | undefined;

/** Returns the launch token if the host exposed one (Electron), else undefined. */
export function getLaunchToken(): string | undefined {
    if (cachedToken) {
        return cachedToken;
    }
    const token = windowConfig()?.launchToken;
    if (typeof token === 'string' && token) {
        cachedToken = token;
        return token;
    }
    return undefined;
}

/** Allows the host shell to provide the token asynchronously (IPC fallback). */
export function setLaunchToken(token: string | undefined): void {
    cachedToken = typeof token === 'string' && token ? token : undefined;
}

/** Base URL for the API when the renderer is not same-origin with it (Electron file://). */
export function getApiBase(): string {
    const base = windowConfig()?.apiBase;
    return typeof base === 'string' ? base.replace(/\/+$/, '') : '';
}

/** Headers every API request should carry. */
export function getApiHeaders(): Record<string, string> {
    const token = getLaunchToken();
    return token ? { [API_TOKEN_HEADER]: token } : {};
}

type HeadersInitLike = Record<string, string> | Array<[string, string]> | { forEach(cb: (value: string, key: string) => void): void };
interface RequestInitLike { headers?: HeadersInitLike; [key: string]: unknown }

function mergeHeaders(existing: HeadersInitLike | undefined, extra: Record<string, string>): Record<string, string> {
    const merged: Record<string, string> = {};
    if (existing) {
        if (Array.isArray(existing)) {
            for (const [k, v] of existing) merged[k] = v;
        } else if (typeof (existing as any).forEach === 'function') {
            // Headers instance (plain objects have no forEach)
            (existing as { forEach(cb: (value: string, key: string) => void): void }).forEach((v, k) => { merged[k] = v; });
        } else {
            Object.assign(merged, existing as Record<string, string>);
        }
    }
    const lowerKeys = new Set(Object.keys(merged).map(k => k.toLowerCase()));
    for (const [k, v] of Object.entries(extra)) {
        if (!lowerKeys.has(k.toLowerCase())) {
            merged[k] = v;
        }
    }
    return merged;
}

/** Merges the API auth headers into a RequestInit without clobbering caller headers. */
export function withApiHeaders<T extends RequestInitLike>(init: T = {} as T): T {
    const auth = getApiHeaders();
    if (Object.keys(auth).length === 0) {
        return init;
    }
    return { ...init, headers: mergeHeaders(init.headers, auth) };
}

/** True when `url` targets the Scratchbox API on the current origin (or the configured apiBase). */
export function isApiUrl(url: string): boolean {
    let pathname: string;
    try {
        const location = hostWindow()?.location;
        const parsed = new URL(url, location ? location.href : 'http://127.0.0.1/');
        const apiBase = getApiBase();
        const sameOrigin = location ? parsed.origin === location.origin : false;
        const isApiBase = !!apiBase && parsed.origin === new URL(apiBase).origin;
        if (!sameOrigin && !isApiBase) {
            return false;
        }
        pathname = parsed.pathname;
    } catch {
        return false;
    }
    return API_PATH_PREFIXES.some(prefix => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
}

/** Appends `?token=` for EventSource URLs, which cannot carry headers. */
export function withApiTokenQuery(url: string): string {
    const token = getLaunchToken();
    if (!token || !isApiUrl(url)) {
        return url;
    }
    const separator = url.includes('?') ? '&' : '?';
    return url.includes('token=') ? url : `${url}${separator}token=${encodeURIComponent(token)}`;
}

let installed = false;

/**
 * Patches `window.fetch` and `window.EventSource` so same-origin API calls
 * carry the launch token. Idempotent. Call once at renderer startup.
 */
export function installApiAuth(): void {
    const win = hostWindow();
    if (installed || !win || typeof win.fetch !== 'function') {
        return;
    }
    installed = true;

    const originalFetch = win.fetch.bind(win);
    const RequestCtor = win.Request;
    win.fetch = (input: any, init?: RequestInitLike) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input?.url ?? '');
        if (!isApiUrl(url)) {
            return originalFetch(input, init);
        }
        if (typeof input !== 'string' && !(input instanceof URL) && RequestCtor && input instanceof RequestCtor) {
            // Request object: copy headers onto a new Request so we don't mutate the caller's.
            const headers = mergeHeaders(input.headers, getApiHeaders());
            return originalFetch(new RequestCtor(input, { headers }), init);
        }
        return originalFetch(input, withApiHeaders(init ?? {}));
    };

    if (typeof win.EventSource === 'function') {
        const OriginalEventSource = win.EventSource;
        const PatchedEventSource = function (this: unknown, url: string | URL, init?: unknown) {
            const target = withApiTokenQuery(typeof url === 'string' ? url : url.toString());
            return new OriginalEventSource(target, init);
        } as any;
        PatchedEventSource.prototype = OriginalEventSource.prototype;
        for (const constant of ['CONNECTING', 'OPEN', 'CLOSED']) {
            Object.defineProperty(PatchedEventSource, constant, { value: OriginalEventSource[constant] });
        }
        win.EventSource = PatchedEventSource;
    }

    // Electron fallback: if the preload could not read argv, ask the main process once.
    if (!getLaunchToken()) {
        const desktop = win.scratchboxDesktop;
        if (desktop && typeof desktop.getLaunchToken === 'function') {
            Promise.resolve(desktop.getLaunchToken())
                .then((token: unknown) => setLaunchToken(typeof token === 'string' ? token : undefined))
                .catch(() => undefined);
        }
    }
}
