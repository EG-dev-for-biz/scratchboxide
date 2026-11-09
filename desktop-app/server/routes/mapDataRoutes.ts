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
import { encodeBlobGroups } from '../../../packages/core/src/common/spatial/map-data-view';
import { buildMapVectorOverlay, discoverBlobGraph, loadBlobGroups, RoadmapTileService, ROADMAP_ZOOM } from '../../../packages/core/src/node/spatial/map-data-service';
import { GoogleVectorTileService } from '../../../packages/core/src/node/spatial/GoogleVectorTileService';
import { stagedWorkspaceRoot } from '../../../packages/core/src/node/3d-engine/staged-location/stage-cache';
import { resolveWithinRoot } from '../../../packages/core/src/node/security/path-guard';
import { RouteContext } from './types';

/**
 * The viewport's Map data view (common/spatial/map-data-view.ts). Every path is resolved inside the workspace.
 *
 * GET /blob-groups?path=<blob_graph.json>      -> application/octet-stream (encodeBlobGroups)
 * GET /discover?model=<model path>             -> { blobGraphPath | null }  a blob graph beside a scene's model
 * GET /vector?lat&lng&radiusM[&scan=<glb>]     -> MapVectorOverlay (+ cached), measured on the scan when given
 * GET /roadmap?lat&lng&radiusM[&zoom]          -> RoadmapManifest (available: false with Google's reason when refused)
 * GET /roadmap/tile/:z/:x/:y                   -> image/png
 * GET /usage                                   -> roadmap tiles fetched from Google (billed) and served from cache
 */
export function createMapDataRouter(ctx: RouteContext, deps: { roadmap?: RoadmapTileService } = {}): Router {
    const router = Router();
    // the staged builds' workspace (SCRATCHBOX_ROOT, else the repo) unless the request names one
    const workspaceRoot = (req: Request) => ctx.requireWorkspaceRoot(typeof req.query.workspaceRoot === 'string' && req.query.workspaceRoot ? req.query.workspaceRoot : stagedWorkspaceRoot());
    const cacheDir = (root: string) => path.join(root, '.scratchbox', 'cache', 'map-data');
    const inWorkspace = (root: string, p: unknown, what: string): string => {
        if (typeof p !== 'string' || !p.trim()) throw Object.assign(new Error(`${what} is required`), { status: 400 });
        const resolved = resolveWithinRoot(root, p.trim());
        if (!fs.existsSync(resolved)) throw Object.assign(new Error(`${what} not found in the workspace: ${p}`), { status: 404 });
        return resolved;
    };
    const fail = (res: Response, err: unknown) => {
        const status = (err as { status?: number }).status;
        if (status) { res.status(status).json({ success: false, error: (err as Error).message }); return; }
        ctx.sendError(res, err);
    };
    const num = (v: unknown, lo: number, hi: number): number | undefined => {
        const n = Number(v);
        return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
    };
    let roadmap = deps.roadmap;
    const roadmapFor = (root: string) => (roadmap ??= new RoadmapTileService({ apiKey: () => GoogleVectorTileService.resolveApiKey(), cacheDir: cacheDir(root) }));

    router.get('/blob-groups', (req: Request, res: Response) => {
        try {
            const root = workspaceRoot(req);
            const file = inWorkspace(root, req.query.path, 'path (a blob graph)');
            const payload = loadBlobGroups(file, p => resolveWithinRoot(root, p));
            const body = encodeBlobGroups(payload);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-store');
            res.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
        } catch (err) {
            fail(res, err);
        }
    });

    router.get('/discover', (req: Request, res: Response) => {
        try {
            const root = workspaceRoot(req);
            const model = typeof req.query.model === 'string' ? req.query.model.replace(/^\/+workspace\/file\?path=/, '') : '';
            let resolved: string | undefined;
            try { resolved = model ? resolveWithinRoot(root, decodeURIComponent(model)) : undefined; } catch { resolved = undefined; }
            const found = resolved && fs.existsSync(resolved) ? discoverBlobGraph(resolved) : undefined;
            res.json({ success: true, blobGraphPath: found ? path.relative(root, found) : null });
        } catch (err) {
            fail(res, err);
        }
    });

    router.get('/vector', async (req: Request, res: Response) => {
        try {
            const root = workspaceRoot(req);
            const lat = num(req.query.lat, -85, 85), lng = num(req.query.lng, -180, 180);
            if (lat === undefined || lng === undefined) { res.status(400).json({ success: false, error: 'lat and lng are required' }); return; }
            const radiusM = num(req.query.radiusM, 20, 1000) ?? 200;
            const scanPath = req.query.scan ? inWorkspace(root, req.query.scan, 'scan') : undefined;
            const r = await buildMapVectorOverlay({
                lat, lng, radiusM, ...(scanPath ? { scanPath } : {}),
                fetchTile: (x, y, z) => GoogleVectorTileService.fetchVectorTile(x, y, z, '') as never,
                cacheDir: cacheDir(root)
            });
            res.json({ success: true, cached: r.cached, overlay: r.overlay });
        } catch (err) {
            fail(res, err);
        }
    });

    router.get('/roadmap', async (req: Request, res: Response) => {
        try {
            const root = workspaceRoot(req);
            const lat = num(req.query.lat, -85, 85), lng = num(req.query.lng, -180, 180);
            if (lat === undefined || lng === undefined) { res.status(400).json({ success: false, error: 'lat and lng are required' }); return; }
            const radiusM = num(req.query.radiusM, 20, 1000) ?? 200;
            const zoom = num(req.query.zoom, 14, 20) ?? ROADMAP_ZOOM;
            res.json({ success: true, ...(await roadmapFor(root).manifest({ lat, lng }, radiusM, Math.round(zoom))) });
        } catch (err) {
            fail(res, err);
        }
    });

    router.get('/roadmap/tile/:z/:x/:y', async (req: Request, res: Response) => {
        try {
            const root = workspaceRoot(req);
            const t = await roadmapFor(root).tile(Number(req.params.z), Number(req.params.x), Number(req.params.y));
            res.setHeader('Content-Type', t.contentType);
            res.setHeader('Cache-Control', 'private, max-age=86400');
            res.end(t.bytes);
        } catch (err) {
            fail(res, err);
        }
    });

    router.get('/usage', (_req: Request, res: Response) => {
        res.json({ success: true, roadmap: roadmap ? roadmap.counts : { fetched: 0, cached: 0, sessions: 0 } });
    });

    return router;
}
