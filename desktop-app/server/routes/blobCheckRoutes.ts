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
import { blobLabelsDir, BlobCheckService, findBlobCheckSources } from '../../../packages/core/src/node/3d-engine/staged-location/street-objects/blob-check';
import { STREET_OBJECTS_DIR } from '../../../packages/core/src/node/gemini/tools/location-evidence/street-objects';
import { RouteContext } from './types';

/** Blob reads are looked for again after this long (ms): a read that finishes meanwhile joins the next check. */
const SOURCES_TTL_MS = 60_000;

/**
 * The blob check a district scene shows (street-objects/blob-check.ts):
 *   GET  /3d/blob-check[?lat=&lng=]  -> { success, check?: { id, lead, subject, note, detail, tiles: [{ id, jpg (base64) }] }, reason? }
 *   POST /3d/blob-check/:id          body { selected: string[], skipped?: boolean } -> { success, stored, controlsPassed }
 * Patches come from blob reads on this machine (the workspace's street-objects outputs, and SCRATCHBOX_BLOB_CHECK_SOURCES);
 * answers are appended to the local blob label store.
 */
export function createBlobCheckRouter(ctx: RouteContext): Router {
    const router = Router();
    const root = stagedWorkspaceRoot();
    const cacheDir = path.join(root, '.scratchbox', 'cache');
    const roots = [path.join(root, STREET_OBJECTS_DIR), ...(process.env.SCRATCHBOX_BLOB_CHECK_SOURCES ?? '').split(/[,:]/).map(s => s.trim()).filter(s => s && path.isAbsolute(s))];
    let cached: { at: number; sources: string[] } | undefined;
    const sources = () => {
        if (!cached || Date.now() - cached.at > SOURCES_TTL_MS) cached = { at: Date.now(), sources: findBlobCheckSources(roots) };
        return cached.sources;
    };
    const service = new BlobCheckService(sources, blobLabelsDir(cacheDir));

    router.get('/', (req: Request, res: Response) => {
        try {
            const lat = Number(req.query.lat), lng = Number(req.query.lng);
            const r = service.next(undefined, Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined);
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
