/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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
export const API_PATH_PREFIXES = [
    '/gemini',
    '/workspace',
    '/media',
    '/api',
    '/video',
    '/3d',
    '/spatial',
    '/models',
    '/cpp',
    '/git',
    '/memories',
    '/compiler'
];

interface ScratchboxWindowConfig {
    launchToken?: string;
    apiBase?: string;
}

interface HostGlobal {
    scratchbox?: ScratchboxWindowConfig;
    scratchboxDesktop?: { getLaunchToken?: () => unknown };
    location?: { href: string; origin: string };
    history?: { replaceState(data: unknown, unused: string, url?: string): void };
    sessionStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem?(key: string): void };
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
    const host = hostWindow();
    const config = host?.scratchbox || (globalThis as any).scratchbox;
    if (config && typeof config === 'object') {
        return config;
    }
    if (typeof process !== 'undefined' && process.env) {
        const envBase = process.env.SCRATCHBOX_API_BASE;
        const envToken = process.env.SCRATCHBOX_LAUNCH_TOKEN;
        if (envBase || envToken) {
            return { apiBase: envBase, launchToken: envToken };
        }
    }
    return undefined;
}

let cachedToken: string | undefined;

/** Returns the launch token if the host exposed one (Electron), else undefined. */
export function getLaunchToken(): string | undefined {
    const fromConfig = windowConfig()?.launchToken;
    if (typeof fromConfig === 'string' && fromConfig) {
        return fromConfig;
    }
    return cachedToken;
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
        const isRelative = url.startsWith('/') || !url.includes('://');
        const defaultBase = location ? location.href : (getApiBase() || 'http://127.0.0.1/');
        const parsed = new URL(url, defaultBase);
        const apiBase = getApiBase();
        const sameOrigin = location ? parsed.origin === location.origin : isRelative;
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

/** Resolves a relative or same-origin API URL to target the configured apiBase when available. */
export function resolveApiUrl(url: string): string {
    const apiBase = getApiBase();
    if (!apiBase) {
        return url;
    }
    try {
        const location = hostWindow()?.location;
        const isRelative = url.startsWith('/') || !url.includes('://');
        const defaultBase = location ? location.href : apiBase;
        const parsed = new URL(url, defaultBase);
        const sameOrigin = location ? parsed.origin === location.origin : isRelative;
        const isApiBase = parsed.origin === new URL(apiBase).origin;
        if (!sameOrigin && !isApiBase) {
            return url;
        }
        const matches = API_PATH_PREFIXES.some(prefix =>
            parsed.pathname === prefix.replace(/\/$/, '') ||
            parsed.pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
        );
        if (matches && (!isApiBase || isRelative)) {
            const cleanBase = apiBase.replace(/\/+$/, '');
            return `${cleanBase}${parsed.pathname}${parsed.search}${parsed.hash}`;
        }
    } catch {
        // Fall back to original url if parsing fails
    }
    return url;
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
 * A tab that outlives a dev-server restart still holds the previous launch's token (kept in sessionStorage), and the
 * server answers 401. Under the Vite dev proxy a request that carries no token gets the current one injected, so drop
 * the stale session token and repeat the request once. Hosts that provide the token themselves (Electron) are left alone.
 */
async function retryWithoutStaleToken(
    win: HostGlobal,
    response: { status: number; clone?: () => { json: () => Promise<any> } },
    url: string,
    init: RequestInitLike | undefined,
    send: (url: string, init?: RequestInitLike) => Promise<any>
): Promise<any | undefined> {
    const body = init?.body;
    if (response.status !== 401 || !cachedToken || windowConfig()?.launchToken) return undefined;
    if (body !== undefined && body !== null && typeof body !== 'string' && !(typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)) return undefined;
    try {
        const payload = await response.clone?.().json();
        if (payload?.error !== 'unauthorized') return undefined;
    } catch {
        return undefined;
    }
    cachedToken = undefined;
    try { win.sessionStorage?.removeItem(SESSION_TOKEN_KEY); } catch { /* storage blocked */ }
    return send(url, init);
}

const LAUNCH_URL_TOKEN_PARAM = 'token';
const SESSION_TOKEN_KEY = 'scratchbox.launchToken';

/**
 * Browser mode receives the token the way Jupyter does: the server/dev
 * launcher prints `http://host/?token=…`. Take it from the URL once, keep it
 * for this tab's session, and strip it from the address bar and history.
 * The API deliberately has no endpoint that hands the token out.
 */
function takeLaunchUrlToken(win: HostGlobal): string | undefined {
    try {
        if (win.location) {
            const url = new URL(win.location.href);
            const fromUrl = url.searchParams.get(LAUNCH_URL_TOKEN_PARAM);
            if (fromUrl) {
                url.searchParams.delete(LAUNCH_URL_TOKEN_PARAM);
                win.history?.replaceState(null, '', url.toString());
                win.sessionStorage?.setItem(SESSION_TOKEN_KEY, fromUrl);
                return fromUrl;
            }
        }
        return win.sessionStorage?.getItem(SESSION_TOKEN_KEY) || undefined;
    } catch {
        // Storage can be blocked; the token then lasts until reload.
        return undefined;
    }
}

/**
 * Resolve the launch token from out-of-band sources only: host config,
 * Electron IPC, or the launch URL. Safe to call multiple times.
 */
export async function acquireLaunchToken(): Promise<string | undefined> {
    const existing = getLaunchToken();
    if (existing) {
        return existing;
    }
    const win = hostWindow();
    const desktop = win?.scratchboxDesktop;
    if (desktop && typeof desktop.getLaunchToken === 'function') {
        try {
            const token = await desktop.getLaunchToken();
            if (typeof token === 'string' && token) {
                setLaunchToken(token);
                return token;
            }
        } catch {
            // Ignore desktop IPC error
        }
    }
    if (win) {
        const fromUrl = takeLaunchUrlToken(win);
        if (fromUrl) {
            setLaunchToken(fromUrl);
            return fromUrl;
        }
    }
    return undefined;
}

/**
 * Patches `window.fetch` and `window.EventSource` so same-origin API calls
 * carry the launch token and route to the active API base URL. Idempotent. Call once at renderer startup.
 */
export function installApiAuth(): void {
    const win = hostWindow();
    if (installed || !win || typeof win.fetch !== 'function') {
        return;
    }
    installed = true;

    // Strip a launch-URL token from the address bar before anything else runs.
    if (!getLaunchToken()) {
        setLaunchToken(takeLaunchUrlToken(win));
    }

    const originalFetch = win.fetch.bind(win);
    const RequestCtor = win.Request;
    win.fetch = async (input: any, init?: RequestInitLike) => {
        const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input?.url ?? '');
        if (!isApiUrl(rawUrl)) {
            return originalFetch(input, init);
        }
        if (!getLaunchToken()) {
            await acquireLaunchToken();
        }
        const resolvedUrl = resolveApiUrl(rawUrl);
        if (typeof input !== 'string' && !(input instanceof URL) && RequestCtor && input instanceof RequestCtor) {
            // Request object: copy headers onto a new Request so we don't mutate the caller's.
            const headers = mergeHeaders(input.headers, getApiHeaders());
            return originalFetch(new RequestCtor(resolvedUrl, { ...input, headers }), init);
        }
        const response = await originalFetch(resolvedUrl, withApiHeaders(init ?? {}));
        return (await retryWithoutStaleToken(win, response, resolvedUrl, init, originalFetch)) ?? response;
    };

    if (typeof win.EventSource === 'function') {
        const OriginalEventSource = win.EventSource;
        const PatchedEventSource = function (this: unknown, url: string | URL, init?: unknown) {
            const rawUrl = typeof url === 'string' ? url : url.toString();
            const resolved = resolveApiUrl(rawUrl);
            const target = withApiTokenQuery(resolved);
            return new OriginalEventSource(target, init);
        } as any;
        PatchedEventSource.prototype = OriginalEventSource.prototype;
        for (const constant of ['CONNECTING', 'OPEN', 'CLOSED']) {
            Object.defineProperty(PatchedEventSource, constant, { value: OriginalEventSource[constant] });
        }
        win.EventSource = PatchedEventSource;
    }

    if (!getLaunchToken()) {
        acquireLaunchToken().catch(() => undefined);
    }
}
