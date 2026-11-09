/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as path from 'path';
import { Request, Response, Router } from 'express';
import { stagedWorkspaceRoot } from '../../../packages/core/src/node/3d-engine/staged-location/stage-cache';
import { findWindowCheckSources, windowCheckRoots, windowLabelsDir, WindowCheckService } from '../../../packages/core/src/node/3d-engine/staged-location/pipeline-k/window-check';
import { RouteContext } from './types';

/** Earlier builds are looked for again after this long (ms): a build that finishes meanwhile joins the next check. */
const SOURCES_TTL_MS = 60_000;

/**
 * The window check the 3D Building overlay shows (pipeline-k/window-check.ts):
 *   GET  /3d/window-check            -> { success, check?: { id, prompt, detail, tiles: [{ id, png (base64) }] }, reason? }
 *   POST /3d/window-check/:id        body { selected: string[], skipped?: boolean } -> { success, stored, controlsPassed }
 * Crops come from earlier pipeline K builds on this machine; answers are appended to the local label store.
 */
export function createWindowCheckRouter(ctx: RouteContext): Router {
    const router = Router();
    const cacheDir = path.join(stagedWorkspaceRoot(), '.scratchbox', 'cache');
    let cached: { at: number; sources: string[] } | undefined;
    const sources = () => {
        if (!cached || Date.now() - cached.at > SOURCES_TTL_MS) cached = { at: Date.now(), sources: findWindowCheckSources(windowCheckRoots(cacheDir)) };
        return cached.sources;
    };
    const service = new WindowCheckService(sources, windowLabelsDir(cacheDir));

    router.get('/', (_req: Request, res: Response) => {
        try {
            const r = service.next();
            res.json({ success: true, ...(r.check ? { check: r.check } : { reason: r.reason }) });
        } catch (err) {
            ctx.sendError(res, err);
        }
    });
    router.post('/:id', (req: Request, res: Response) => {
        const id = String(req.params.id);
        if (!/^[0-9a-f]{16}$/.test(id)) { res.status(400).json({ success: false, error: 'the check id is 16 hex digits' }); return; }
        const body = req.body || {};
        const selected = Array.isArray(body.selected) ? body.selected.filter((s: unknown): s is string => typeof s === 'string') : [];
        try {
            res.json({ success: true, ...service.answer(id, selected, body.skipped === true) });
        } catch (err: any) {
            res.status(404).json({ success: false, error: err?.message ?? String(err) });
        }
    });
    return router;
}
