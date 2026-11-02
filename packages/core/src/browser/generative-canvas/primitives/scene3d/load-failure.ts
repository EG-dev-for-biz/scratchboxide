/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * How the viewport tells a model file that is missing from one it could not reach. A served file that answers 404 is
 * missing: asset recovery restores or rebuilds it, and a file still missing after that is a real failure the viewport
 * reports. A fetch that never got an answer (`TypeError: Failed to fetch`, `Load failed`, a connection refused) is the
 * server being away, most often the dev server restarting under the open page: the file is still there, recovery would
 * find it present and change nothing, and a red "5 models failed to load" over the viewport is wrong. Those loads are
 * tried again on their own, with these delays, and only reported when every try failed.
 *
 * A model URL answered with the app's own HTML page (the dev server's page fallback, while the backend that serves the
 * file is away: the loader then fails with `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`) is the same
 * situation seen through a different error: it is retried with the same delays, and when the retries are spent the file
 * goes to asset recovery (restored from the asset store, or rebuilt), since by then the server is answering and the
 * file really is not there.
 */

/** Delays before each retry of a load that failed to reach the server (about 30 s in all: a dev server restart takes 10-25 s). */
export const NETWORK_RETRY_DELAYS_MS: ReadonlyArray<number> = [1_000, 2_000, 4_000, 8_000, 15_000];

/** The delay before retry number `attempt` (1-based), or undefined when the retries are spent. */
export function networkRetryDelayMs(attempt: number): number | undefined {
    return attempt >= 1 && attempt <= NETWORK_RETRY_DELAYS_MS.length ? NETWORK_RETRY_DELAYS_MS[attempt - 1] : undefined;
}

/**
 * Whether a load error is the server being unreachable rather than an answer about the file. three.js's FileLoader
 * throws `fetch for "<url>" responded with <status>: <text>` for an HTTP answer and lets the browser's own
 * `TypeError: Failed to fetch` / `Load failed` / `NetworkError when attempting to fetch resource` through when the
 * connection failed; an abort is neither.
 */
export function isNetworkLoadFailure(err: unknown): boolean {
    const message = String((err as { message?: unknown } | undefined)?.message ?? err ?? '').trim();
    if (!message) return false;
    if (/responded with \d{3}/i.test(message)) return false;
    if (/abort/i.test(message) && (err as { name?: string } | undefined)?.name === 'AbortError') return false;
    return /failed to fetch|load failed|networkerror|network request failed|err_connection|err_network|err_internet_disconnected|fetch failed|ECONNREFUSED|ECONNRESET/i.test(message);
}

/**
 * Whether a load error is the app's HTML page served where a model file was asked for (a page fallback): GLTFLoader
 * parsing `<!DOCTYPE html>` as glTF JSON, or a loader quoting the page.
 */
export function isAppPageAnswer(err: unknown): boolean {
    const message = String((err as { message?: unknown } | undefined)?.message ?? err ?? '');
    return /<!doctype|<html|unexpected token '?<'?/i.test(message);
}

/**
 * Whether a load error is the server saying the file is not there (404 or 410): a saved scene whose files were made in
 * another checkout of the app, or deleted. The viewport says so in plain words rather than quoting the loader.
 */
export function isMissingFileAnswer(err: unknown): boolean {
    const message = String((err as { message?: unknown } | undefined)?.message ?? err ?? '');
    return /responded with (404|410)\b/i.test(message);
}
