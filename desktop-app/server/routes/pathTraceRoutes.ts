/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Request, Response, Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import {
    MetalPathTracerError,
    MetalPathTracerService,
    MetalPathTraceSession,
    VIRTUAL_GEOMETRY_URL_PREFIX,
    virtualGeometryServeDir
} from '../../../packages/core/src/node';
import { resolveWithinRoot } from '../../../packages/core/src/node/security/path-guard';
import { RouteContext } from './types';

/**
 * Progressive Metal path tracing of a virtual geometry file, one resident GPU process per session.
 *
 * POST /open   { sbvgUrl, sourceGlbPath?, workspaceRoot?, lighting?, material? }
 *     -> { success, sessionId, device, file, materials }        (503 with the reason when there is no ray tracing device)
 * POST /view   { sessionId, width, height, camera, lod?, maxBounces?, targetSpp? }
 *     -> { success, seq, cut, lighting, targetSpp }
 * GET  /frame?sessionId=..&after=<seq>.<spp>
 *     -> 204 while the newest frame is not newer than `after`, else the RGBA bytes with
 *        X-Frame-Seq, X-Frame-Spp, X-Frame-Rays, X-Frame-Gpu-Ms, X-Frame-Width, X-Frame-Height, X-Frame-Done
 * POST /close  { sessionId } -> { success }
 * Sessions idle for 10 minutes are closed.
 */
export function createPathTraceRouter(service: MetalPathTracerService, ctx: RouteContext): Router {
    const router = Router();
    const sessions = new Map<string, MetalPathTraceSession>();
    let nextId = 1;
    const idleMs = 10 * 60_000;

    const reap = () => {
        const now = Date.now();
        for (const [id, s] of sessions) {
            if (!s.alive || now - s.lastUsed > idleMs) {
                s.close();
                sessions.delete(id);
            }
        }
    };
    setInterval(reap, 60_000).unref();

    /** The served file a /build/3d-virtual-geometry/<name>.sbvg URL names, inside the serve directory. */
    const sbvgPathFromUrl = (url: unknown): string => {
        if (typeof url !== 'string' || !url.startsWith(`${VIRTUAL_GEOMETRY_URL_PREFIX}/`)) {
            throw new MetalPathTracerError(`sbvgUrl must be a served virtual geometry file (${VIRTUAL_GEOMETRY_URL_PREFIX}/<name>.sbvg)`);
        }
        const name = url.slice(VIRTUAL_GEOMETRY_URL_PREFIX.length + 1).split('?')[0];
        if (!/^[A-Za-z0-9_-]+\.sbvg$/.test(name)) throw new MetalPathTracerError(`sbvgUrl names no .sbvg file: ${url}`);
        const file = path.join(virtualGeometryServeDir(), name);
        if (!fs.existsSync(file)) throw new MetalPathTracerError(`${url} is not on the server; rebuild the virtual geometry`);
        return file;
    };

    const fail = (res: Response, err: unknown) => {
        if (err instanceof MetalPathTracerError) {
            const noDevice = /no Metal device|does not support ray tracing|macOS only/.test(err.message);
            res.status(noDevice ? 503 : 422).json({ success: false, error: err.message });
            return;
        }
        ctx.sendError(res, err);
    };

    router.post('/open', async (req: Request, res: Response) => {
        const body = req.body || {};
        try {
            const sbvgPath = sbvgPathFromUrl(body.sbvgUrl);
            let glbPath: string | undefined;
            if (typeof body.sourceGlbPath === 'string' && body.sourceGlbPath.trim()) {
                const root = ctx.requireWorkspaceRoot(body.workspaceRoot);
                glbPath = resolveWithinRoot(root, body.sourceGlbPath.trim());
                if (!fs.existsSync(glbPath)) {
                    res.status(404).json({ success: false, error: `GLB not found in the workspace (${root}): ${body.sourceGlbPath}` });
                    return;
                }
            }
            const session = await service.openSession({
                sbvgPath,
                ...(glbPath ? { glbPath } : {}),
                ...(body.lighting ? { lighting: body.lighting } : {}),
                ...(body.material ? { material: body.material } : {})
            });
            const sessionId = `pt${nextId++}`;
            sessions.set(sessionId, session);
            session.on('exit', () => sessions.delete(sessionId));
            session.on('error', () => undefined);
            res.json({ success: true, sessionId, ...session.opened });
        } catch (err) {
            fail(res, err);
        }
    });

    router.post('/view', async (req: Request, res: Response) => {
        const body = req.body || {};
        const session = sessions.get(String(body.sessionId));
        if (!session || !session.alive) {
            res.status(404).json({ success: false, error: 'unknown or closed path tracing session; open it again' });
            return;
        }
        try {
            const { sessionId: _ignored, ...view } = body;
            const started = await session.setView(view);
            res.json({ success: true, ...started });
        } catch (err) {
            fail(res, err);
        }
    });

    router.get('/frame', (req: Request, res: Response) => {
        const session = sessions.get(String(req.query.sessionId ?? ''));
        if (!session || !session.alive) {
            res.status(404).json({ success: false, error: 'unknown or closed path tracing session; open it again' });
            return;
        }
        session.lastUsed = Date.now();
        const frame = session.latestFrame();
        if (!frame) {
            res.status(204).end();
            return;
        }
        const after = String(req.query.after ?? '');
        if (after === `${frame.seq}.${frame.spp}`) {
            res.status(204).end();
            return;
        }
        const read = session.readFrame();
        if (!read) {
            res.status(204).end();
            return;
        }
        res.set({
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'no-store',
            // The page runs on another origin in development; without this the browser hides the frame headers.
            'Access-Control-Expose-Headers': 'X-Frame-Seq, X-Frame-Spp, X-Frame-Rays, X-Frame-Gpu-Ms, X-Frame-Width, X-Frame-Height, X-Frame-Done, X-Frame-Denoised, X-Frame-Denoise-Ms, X-Frame-History, X-Frame-Render-Width, X-Frame-Render-Height, X-Frame-Upscale-Ms',
            'X-Frame-Render-Width': String(read.meta.renderWidth ?? read.meta.width),
            'X-Frame-Render-Height': String(read.meta.renderHeight ?? read.meta.height),
            'X-Frame-Upscale-Ms': Number(read.meta.upscaleMs ?? 0).toFixed(3),
            'X-Frame-Denoised': read.meta.denoised ? '1' : '0',
            'X-Frame-Denoise-Ms': Number(read.meta.denoiseMs ?? 0).toFixed(3),
            'X-Frame-History': String(read.meta.historyPixels ?? 0),
            'X-Frame-Seq': String(read.meta.seq),
            'X-Frame-Spp': String(read.meta.spp),
            'X-Frame-Rays': String(read.meta.rays),
            'X-Frame-Gpu-Ms': read.meta.gpuMs.toFixed(3),
            'X-Frame-Width': String(read.meta.width),
            'X-Frame-Height': String(read.meta.height),
            'X-Frame-Done': read.meta.done ? '1' : '0'
        });
        res.send(read.rgba);
    });

    router.post('/close', (req: Request, res: Response) => {
        const id = String((req.body || {}).sessionId ?? '');
        const session = sessions.get(id);
        if (session) {
            session.close();
            sessions.delete(id);
        }
        res.json({ success: true, closed: Boolean(session) });
    });

    return router;
}
