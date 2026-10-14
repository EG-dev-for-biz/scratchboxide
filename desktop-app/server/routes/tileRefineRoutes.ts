/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Request, Response, Router } from 'express';
import {
    findTileRefineRepoRoot,
    getTileRefineService,
    TileRefineError
} from '../../../packages/core/src/node/3d-engine/tile-refine-service';
import { RouteContext } from './types';

const STATUS: Record<string, number> = { bad_request: 400, not_found: 404, timeout: 504, failed: 500, build_failed: 500 };

/**
 * POST /3d/tiles/refine — raw photogrammetric tile GLB -> refined textured + clay GLBs (cached).
 * Body: { tilePath | glbPath, anchor?, roiRadius?, relief?, isolate?, publishAs?, thumbnails?, timeoutMs?, workspaceRoot? }
 * `isolate: true` (or `{ apron }`) refines only the structure under the anchor, whole, plus a ground apron.
 * Paths are relative to the workspace root (default: the checkout that holds the tile_refine sources).
 */
export function createTileRefineRouter(ctx: RouteContext): Router {
    const router = Router();
    const defaultRoot = findTileRefineRepoRoot();

    router.post('/refine', async (req: Request, res: Response) => {
        try {
            const body = req.body || {};
            const root = ctx.requireWorkspaceRoot(body.workspaceRoot ?? defaultRoot);
            const r = await getTileRefineService(root).refine({
                tilePath: body.tilePath,
                glbPath: body.glbPath,
                anchor: body.anchor,
                roiRadius: body.roiRadius,
                relief: body.relief,
                isolate: body.isolate,
                publishAs: body.publishAs,
                thumbnails: body.thumbnails,
                timeoutMs: body.timeoutMs
            });
            res.json({
                success: true,
                texturedGlb: r.texturedGlb,
                clayGlb: r.clayGlb,
                rawClayGlb: r.rawClayGlb,
                thumbnailsDir: r.thumbnailsDir,
                stats: r.stats,
                cached: r.cached,
                ms: r.ms,
                cacheKey: r.cacheKey,
                published: r.published,
                binary: r.binary
            });
        } catch (err: any) {
            if (err instanceof TileRefineError) {
                res.status(STATUS[err.code] ?? 500).json({ success: false, error: err.code, message: err.message, detail: err.detail });
                return;
            }
            ctx.sendError(res, err);
        }
    });

    return router;
}
