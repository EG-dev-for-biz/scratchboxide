/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Resolves a texture-library path (what used to be a relative `/textures/...` or
 * `/extracted_textures/...` asset served straight out of `public/`) into a short-lived v4 signed
 * URL against the private `scratchbox-library-training-textures` GCS bucket, via the server's
 * `/api/textures/sign` route. Any URL that is already absolute, a `data:`/`blob:` URI, or otherwise
 * not one of our own texture-library paths passes through untouched.
 */

/** Root-relative prefixes that identify a texture-library asset (mirrors the server's allow-list). */
const TEXTURE_LIBRARY_ROOTS = ['textures/', 'extracted_textures/'];

interface CachedSignedUrl {
    url: string;
    expiresAt: number;
    pending?: Promise<string>;
}

const signedUrlCache = new Map<string, CachedSignedUrl>();

function isTextureLibraryPath(url: string): boolean {
    if (!url) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('/')) {
        // Has a URL scheme (http:, https:, data:, blob:, ...) — not a local library path.
        return false;
    }
    const relative = url.replace(/^\/+/, '');
    return TEXTURE_LIBRARY_ROOTS.some(root => relative.startsWith(root));
}

async function fetchSignedUrl(objectPath: string): Promise<string> {
    const response = await fetch(`/api/textures/sign?path=${encodeURIComponent(objectPath)}`);
    if (!response.ok) {
        throw new Error(`Failed to sign texture URL for "${objectPath}": HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!data?.success || typeof data.url !== 'string') {
        throw new Error(`Texture signing service returned no URL for "${objectPath}"`);
    }
    return data.url as string;
}

/**
 * Resolves `rawUrl` to a fetchable URL. Texture-library paths are exchanged for a signed GCS URL
 * (cached in-memory until shortly before it expires); everything else is returned unchanged.
 */
export async function resolveTextureUrl(rawUrl: string): Promise<string> {
    if (!isTextureLibraryPath(rawUrl)) {
        return rawUrl;
    }
    const objectPath = rawUrl.replace(/^\/+/, '');
    const now = Date.now();
    const cached = signedUrlCache.get(objectPath);
    if (cached) {
        if (cached.pending) {
            return cached.pending;
        }
        if (cached.expiresAt - now > 60_000) {
            return cached.url;
        }
    }

    const pending = fetchSignedUrl(objectPath);
    signedUrlCache.set(objectPath, { url: cached?.url ?? '', expiresAt: cached?.expiresAt ?? 0, pending });
    try {
        const url = await pending;
        // Signed URLs carry their own expiry in the query string; match the server's TTL so we
        // re-sign slightly before it actually expires rather than finding out from a failed fetch.
        signedUrlCache.set(objectPath, { url, expiresAt: now + 14 * 60 * 1000 });
        return url;
    } catch (err) {
        signedUrlCache.delete(objectPath);
        throw err;
    }
}
