/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Request, Response, Router } from 'express';
import { beautifyViewportFrame, type ViewportBeautifyDeps } from '../../../packages/core/src/node/spatial/viewport-beautify-service';
import { classifyMediaGenerationError } from '../../../packages/core/src/common/media-generation-protocol';
import { isPathError, type RouteContext } from './types';

/** Largest viewport frame accepted, in bytes once decoded. */
const MAX_FRAME_BYTES = 30 * 1024 * 1024;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * POST /api/viewport-beautify { imageBase64, mimeType?, width, height, sceneName, place?, headingDeg?, pitchDeg?, fovDeg?,
 * subjectDistanceM?, workspaceRoot? } → { success, imageBase64 (PNG), modelUsed, modelNote, aspectRatio, imageSize }.
 * The viewport's quick AI Beautify (QuickBeautifyButton.tsx): one image model call, the answer returned for download.
 * A closed request (the viewport went away) stops the model call.
 */
export function createViewportBeautifyRouter(
    deps: Pick<ViewportBeautifyDeps, 'mediaService' | 'assetStore'>,
    ctx: Pick<RouteContext, 'requireWorkspaceRoot'>
): Router {
    const router = Router();
    router.post('/', async (req: Request, res: Response) => {
        const body = req.body || {};
        if (typeof body.imageBase64 !== 'string' || !body.imageBase64) {
            return res.status(400).json({ success: false, error: { code: 'invalid_request', message: 'imageBase64 (the viewport frame) is required' } });
        }
        const bytes = Buffer.from(body.imageBase64, 'base64');
        if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) {
            return res.status(400).json({ success: false, error: { code: 'invalid_request', message: `the frame must be 1 byte to ${MAX_FRAME_BYTES / 1024 / 1024} MB` } });
        }
        const width = num(body.width), height = num(body.height);
        if (!width || !height || width <= 0 || height <= 0) {
            return res.status(400).json({ success: false, error: { code: 'invalid_request', message: 'width and height (the frame size in pixels) are required' } });
        }
        const place = body.place && typeof body.place === 'object' && num(body.place.lat) !== undefined && num(body.place.lng) !== undefined
            ? { lat: body.place.lat as number, lng: body.place.lng as number, ...(typeof body.place.name === 'string' ? { name: body.place.name } : {}) }
            : undefined;
        const abort = new AbortController();
        res.on('close', () => { if (!res.writableEnded) abort.abort(); });
        try {
            const workspaceRoot = ctx.requireWorkspaceRoot(body.workspaceRoot);
            const out = await beautifyViewportFrame(
                { bytes, mimeType: body.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png' },
                {
                    sceneName: typeof body.sceneName === 'string' ? body.sceneName : '',
                    place,
                    headingDeg: num(body.headingDeg),
                    pitchDeg: num(body.pitchDeg),
                    fovDeg: num(body.fovDeg),
                    subjectDistanceM: num(body.subjectDistanceM),
                    width,
                    height
                },
                { ...deps, workspaceRoot },
                abort.signal
            );
            res.json({
                success: true,
                imageBase64: out.png.toString('base64'),
                mimeType: 'image/png',
                modelUsed: out.modelUsed,
                modelNote: out.modelNote,
                aspectRatio: out.aspectRatio,
                imageSize: out.imageSize
            });
        } catch (err: any) {
            if (isPathError(err)) {
                return res.status(403).json({ success: false, error: { code: 'invalid_request', message: err.message } });
            }
            const detail = err?.mediaError || classifyMediaGenerationError(err);
            const status = detail.code === 'unauthorized' ? 401
                : detail.code === 'quota' ? 429
                    : detail.code === 'invalid_request' ? 400
                        : detail.code === 'unsupported' ? 422 : 500;
            if (!res.headersSent) res.status(status).json({ success: false, error: detail });
        }
    });
    return router;
}
