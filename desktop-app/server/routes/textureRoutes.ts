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
 * Root-relative prefixes that identify a texture-library asset, and where each sits in the bucket. Anything else is
 * rejected; this is a validity check on the request, not a routing taxonomy: any object under a root may be requested,
 * however it is named.
 *   - `texture-library/<set>/<file>`: the material sets stored at the bucket's root (`Bricks001/…`, `granite_wall/…`);
 *   - `textures/…`, `extracted_textures/…`: the paths that used to be served from `public/`, kept under the same key.
 */
const TEXTURE_ROOTS: ReadonlyArray<{ root: string; keyPrefix: string }> = [
    { root: 'texture-library', keyPrefix: '' },
    { root: 'textures', keyPrefix: 'textures/' },
    { root: 'extracted_textures', keyPrefix: 'extracted_textures/' }
];

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
 * Normalizes and validates a client-supplied texture path and returns the bucket object it names. Rejects absolute
 * filesystem paths, `..` traversal, and anything outside the texture-library roots.
 */
export function textureObjectKey(raw: unknown): string {
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
    const [root, ...rest] = normalized.split('/');
    const entry = TEXTURE_ROOTS.find(r => r.root === root);
    if (!entry || !rest.length || !rest.join('/')) {
        throw new TextureSignError(`Texture path must start with one of: ${TEXTURE_ROOTS.map(r => `${r.root}/`).join(', ')}`, 400);
    }
    return entry.keyPrefix + rest.join('/');
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
            const objectKey = textureObjectKey(req.query.path);

            const cached = cache.get(objectKey);
            const now = Date.now();
            if (cached && cached.expiresAt - now > SIGNED_URL_REFRESH_MARGIN_MS) {
                res.json({ success: true, url: cached.url, expiresAt: cached.expiresAt, bucket: bucketName, path: objectKey });
                return;
            }

            const storage = mediaCredentials.createStorageClient();
            const file = storage.bucket(bucketName).file(objectKey);
            // A signature is minted locally whatever the signer may read, so a URL for a missing object, or one the
            // service account cannot read, would only fail later in the browser. Read the object's metadata first.
            try {
                await file.getMetadata();
            } catch (err) {
                const code = (err as { code?: number }).code;
                if (code === 404) {
                    throw new TextureSignError(`No texture "${objectKey}" in gs://${bucketName}`, 404);
                }
                if (code === 403) {
                    const who = await storage.authClient.getCredentials().then(c => c.client_email, () => undefined);
                    throw new TextureSignError(`${who ?? 'The server\'s Google credentials'} cannot read gs://${bucketName}: grant it roles/storage.objectViewer on the bucket`, 403);
                }
                throw err;
            }
            const expiresAt = now + SIGNED_URL_TTL_MS;
            const [url] = await file.getSignedUrl({
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
            res.status(500).json({ success: false, error: message });
        }
    });

    return router;
}
