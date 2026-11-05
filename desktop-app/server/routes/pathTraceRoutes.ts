/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import bodyParser from 'body-parser';
import * as crypto from 'crypto';
import { Request, Response, Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import {
    MetalPathTracerError,
    MetalPathTracerService,
    MetalPathTraceSession,
    getVirtualGeometryBuildService,
    readSbvgOrigin,
    VirtualGeometryBuildError,
    VIRTUAL_GEOMETRY_URL_PREFIX,
    virtualGeometryServeDir
} from '../../../packages/core/src/node';
import { resolveWithinRoot } from '../../../packages/core/src/node/security/path-guard';
import { RouteContext } from './types';

/**
 * Progressive Metal path tracing of a virtual geometry file, one resident GPU process per session.
 *
 * POST /snapshot  body: a binary GLB (model/gltf-binary) of what a viewport shows
 *     -> { success, snapshotId, sbvgUrl, origin, cached, summary }  (built once per content; the newest 24 are kept)
 * POST /open   { sbvgUrl, sourceGlbPath?, workspaceRoot?, snapshotId?, lighting?, material? }
 *     -> { success, sessionId, device, file, materials }        (503 with the reason when there is no ray tracing device)
 * POST /view   { sessionId, width, height, camera, lod?, maxBounces?, targetSpp? }
 *     -> { success, seq, cut, lighting, targetSpp }
 * GET  /frame?sessionId=..&after=<seq>.<spp>
 *     -> 204 while the newest frame is not newer than `after`, else the RGBA bytes with
 *        X-Frame-Seq, X-Frame-Spp, X-Frame-Rays, X-Frame-Gpu-Ms, X-Frame-Width, X-Frame-Height, X-Frame-Done
 * POST /render { sessionId, width, height, camera, samplesPerPixel?, maxBounces?, exposureEv?, workspaceRoot?, name? }
 *     -> { success, path, stats }  one denoised still of the session's file, materials and light, saved as a PNG in
 *        the workspace's renders/path-traced/ with a JSON of how it was made beside it
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

    /** Scene snapshots (GLBs a viewport sent), kept beside the builds they were made into. */
    const snapshotDir = () => path.join(virtualGeometryServeDir(), 'scene-snapshots');
    const snapshotKeep = 24;
    const snapshotPath = (id: unknown): string => {
        if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw new MetalPathTracerError('snapshotId names no scene snapshot');
        const file = path.join(snapshotDir(), `${id}.glb`);
        if (!fs.existsSync(file)) throw new MetalPathTracerError('the scene snapshot is no longer on the server; capture the scene again');
        return file;
    };
    const pruneSnapshots = () => {
        const dir = snapshotDir();
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.glb'))
            .map(f => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
        for (const old of files.slice(snapshotKeep)) fs.rmSync(old.file, { force: true });
    };

    const fail = (res: Response, err: unknown) => {
        if (err instanceof VirtualGeometryBuildError) {
            res.status(422).json({ success: false, error: err.message });
            return;
        }
        if (err instanceof MetalPathTracerError) {
            const noDevice = /no Metal device|does not support ray tracing|macOS only/.test(err.message);
            res.status(noDevice ? 503 : 422).json({ success: false, error: err.message });
            return;
        }
        ctx.sendError(res, err);
    };

    router.post('/snapshot', bodyParser.raw({ type: 'model/gltf-binary', limit: '4gb' }), async (req: Request, res: Response) => {
        const glb = req.body;
        if (!Buffer.isBuffer(glb) || glb.length < 20 || glb.readUInt32LE(0) !== 0x46546c67) {
            res.status(400).json({ success: false, error: 'the body must be a binary GLB sent as model/gltf-binary' });
            return;
        }
        try {
            const snapshotId = crypto.createHash('sha256').update(glb).digest('hex').slice(0, 32);
            fs.mkdirSync(snapshotDir(), { recursive: true });
            const file = path.join(snapshotDir(), `${snapshotId}.glb`);
            if (fs.existsSync(file)) {
                const now = new Date();
                fs.utimesSync(file, now, now);
            } else {
                fs.writeFileSync(`${file}.tmp`, glb);
                fs.renameSync(`${file}.tmp`, file);
            }
            pruneSnapshots();
            const built = await getVirtualGeometryBuildService().buildServed(file);
            res.json({ success: true, snapshotId, sbvgUrl: built.sbvgUrl, origin: readSbvgOrigin(built.sbvgPath), cached: built.cached, summary: built.summary });
        } catch (err) {
            fail(res, err);
        }
    });

    router.post('/open', async (req: Request, res: Response) => {
        const body = req.body || {};
        try {
            const sbvgPath = sbvgPathFromUrl(body.sbvgUrl);
            let glbPath: string | undefined;
            if (body.snapshotId !== undefined) {
                glbPath = snapshotPath(body.snapshotId);
            } else if (typeof body.sourceGlbPath === 'string' && body.sourceGlbPath.trim()) {
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
            res.json({ success: true, sessionId, ...session.opened, origin: readSbvgOrigin(sbvgPath) });
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
        // Nothing new: the client has this frame, or the frame belongs to a view older than the one it asked for.
        const after = String(req.query.after ?? '');
        const seq = Number(req.query.seq);
        if (after === `${frame.seq}.${frame.spp}` || (Number.isFinite(seq) && frame.seq < seq)) {
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
            'Access-Control-Expose-Headers': 'X-Frame-Seq, X-Frame-Spp, X-Frame-Rays, X-Frame-Gpu-Ms, X-Frame-Width, X-Frame-Height, X-Frame-Display-Width, X-Frame-Display-Height, X-Frame-Done, X-Frame-Denoised, X-Frame-Denoise-Ms, X-Frame-History, X-Frame-Render-Width, X-Frame-Render-Height, X-Frame-Upscale-Ms',
            'X-Frame-Display-Width': String(read.meta.displayWidth ?? read.meta.width),
            'X-Frame-Display-Height': String(read.meta.displayHeight ?? read.meta.height),
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

    router.post('/render', async (req: Request, res: Response) => {
        const body = req.body || {};
        const session = sessions.get(String(body.sessionId));
        if (!session || !session.alive || !session.openRequest) {
            res.status(404).json({ success: false, error: 'unknown or closed path tracing session; open it again' });
            return;
        }
        const width = Number(body.width), height = Number(body.height);
        if (!(width >= 8 && width <= 8192 && height >= 8 && height <= 8192)) {
            res.status(400).json({ success: false, error: 'width and height must be between 8 and 8192' });
            return;
        }
        if (!body.camera || !Array.isArray(body.camera.position) || !Array.isArray(body.camera.target)) {
            res.status(400).json({ success: false, error: 'camera.position and camera.target are required' });
            return;
        }
        try {
            const root = ctx.requireWorkspaceRoot(body.workspaceRoot);
            session.lastUsed = Date.now();
            const open = session.openRequest;
            const outputDir = fs.mkdtempSync(path.join(session.dir, 'still-'));
            const exposureEv = typeof body.exposureEv === 'number' ? body.exposureEv : session.latestFrame()?.exposureEv;
            const result = await service.render({
                sbvgPath: open.sbvgPath,
                outputDir,
                width: Math.round(width),
                height: Math.round(height),
                samplesPerPixel: Math.max(1, Math.min(16384, Math.round(Number(body.samplesPerPixel) || 1024))),
                maxBounces: Math.max(1, Math.min(16, Math.round(Number(body.maxBounces) || 4))),
                denoise: true,
                optimizations: { sampler: 'sobol' },
                camera: body.camera,
                ...(open.lighting ? { lighting: open.lighting } : {}),
                ...(open.glbPath ? { materials: { glbPath: open.glbPath } } : open.material ? { material: open.material } : {}),
                ...(exposureEv !== undefined ? { exposureEv } : {})
            });
            const slug = (typeof body.name === 'string' ? body.name : 'scene').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'scene';
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const relative = path.posix.join('renders', 'path-traced', `${slug}-${stamp}.png`);
            const target = resolveWithinRoot(root, relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(result.beautyPngPath, target);
            const s = result.stats;
            const record = {
                renderer: 'Metal path tracer (sbvg_pathtracer)', device: s.device,
                width: s.width, height: s.height, samplesPerPixel: s.samplesPerPixel, maxBounces: s.maxBounces,
                denoised: s.denoised, exposureEv: s.exposureEv, lighting: open.lighting ?? { studio: {} },
                camera: s.camera, cut: s.cut, geometryCoverage: s.geometryCoverage, materials: s.materials, renderMs: s.renderMs, raysPerSecond: s.raysPerSecond
            };
            fs.writeFileSync(target.replace(/\.png$/, '.json'), JSON.stringify(record, null, 2), 'utf8');
            fs.rmSync(outputDir, { recursive: true, force: true });
            res.json({ success: true, path: relative, stats: record });
        } catch (err) {
            fail(res, err);
        }
    });

    router.post('/pause', async (req: Request, res: Response) => {
        const session = sessions.get(String((req.body || {}).sessionId ?? ''));
        if (!session || !session.alive) {
            res.status(404).json({ success: false, error: 'unknown or closed path tracing session; open it again' });
            return;
        }
        try {
            const paused = await session.pause();
            res.json({ success: true, ...paused });
        } catch (err) {
            fail(res, err);
        }
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
