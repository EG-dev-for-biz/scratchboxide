/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Request, Response, Router } from 'express';
import * as path from 'path';
import { GoogleMediaCredentialsService } from '../../../packages/core/src/node';

/**
 * Root-relative prefixes that still identify a texture-library asset. Anything else is rejected —
 * this is a validity check on the request, not a routing taxonomy: any object under either root may
 * be requested, however it is named.
 */
const ALLOWED_TEXTURE_ROOTS = ['textures', 'extracted_textures'];

/** How long a signed URL (and our in-memory cache of it) stays valid for. */
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;
/** Re-sign once less than this much of the TTL remains, so a client never races an expiring URL. */
const SIGNED_URL_REFRESH_MARGIN_MS = 60 * 1000;

class TextureSignError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

/**
 * Normalizes and validates a client-supplied texture path into a safe GCS object key.
 * Rejects absolute filesystem paths, `..` traversal, and anything outside the known
 * texture-library roots that used to be served from `public/`.
 */
function sanitizeTextureObjectKey(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) {
        throw new TextureSignError('Missing required "path" query parameter', 400);
    }
    const stripped = raw.trim().replace(/^\/+/, '');
    if (stripped.includes('\0')) {
        throw new TextureSignError('Invalid texture path', 400);
    }
    const normalized = path.posix.normalize(stripped);
    if (normalized === '.' || normalized.startsWith('..') || normalized.includes('/../') || path.posix.isAbsolute(normalized)) {
        throw new TextureSignError('Invalid texture path', 400);
    }
    const [root] = normalized.split('/');
    if (!ALLOWED_TEXTURE_ROOTS.includes(root)) {
        throw new TextureSignError(`Texture path must start with one of: ${ALLOWED_TEXTURE_ROOTS.join(', ')}`, 400);
    }
    return normalized;
}

interface CachedSignedUrl {
    url: string;
    expiresAt: number;
}

/**
 * Issues short-lived v4 signed URLs for objects in the private texture-library GCS bucket, so the
 * frontend can fetch textures without the bucket ever being made public.
 */
export function createTextureRouter(mediaCredentials: GoogleMediaCredentialsService): Router {
    const router = Router();
    const bucketName = process.env.GCS_TEXTURE_BUCKET || 'scratchbox-library-training-textures';
    const cache = new Map<string, CachedSignedUrl>();

    router.get('/sign', async (req: Request, res: Response) => {
        try {
            const objectKey = sanitizeTextureObjectKey(req.query.path);

            const cached = cache.get(objectKey);
            const now = Date.now();
            if (cached && cached.expiresAt - now > SIGNED_URL_REFRESH_MARGIN_MS) {
                res.json({ success: true, url: cached.url, expiresAt: cached.expiresAt, bucket: bucketName, path: objectKey });
                return;
            }

            const storage = mediaCredentials.createStorageClient();
            const expiresAt = now + SIGNED_URL_TTL_MS;
            const [url] = await storage.bucket(bucketName).file(objectKey).getSignedUrl({
                version: 'v4',
                action: 'read',
                expires: expiresAt
            });

            cache.set(objectKey, { url, expiresAt });
            res.json({ success: true, url, expiresAt, bucket: bucketName, path: objectKey });
        } catch (err) {
            if (err instanceof TextureSignError) {
                res.status(err.status).json({ success: false, error: err.message });
                return;
            }
            const message = err instanceof Error ? err.message : String(err);
            const notFound = /no such object/i.test(message);
            res.status(notFound ? 404 : 500).json({ success: false, error: message });
        }
    });

    return router;
}
