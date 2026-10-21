/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The durable asset store's API (/api/assets): what a served path resolves to, the change log, and recovery jobs for
 * files that are missing (restored from the store or rebuilt from their recipe, with progress and cancel).
 */

import { Request, Response, Router } from 'express';
import type { DurableAssetStore } from '../../../packages/core/src/node/asset-store/durable-asset-store';
import type { AssetRecoveryService } from '../../../packages/core/src/node/asset-store/asset-recovery-service';

const MAX_RECOVERY_PATHS = 200;

export function createAssetRouter(store: DurableAssetStore, recovery: AssetRecoveryService): Router {
    const router = Router();

    router.get('/lookup', (req: Request, res: Response) => {
        const servedPath = typeof req.query.path === 'string' ? req.query.path : '';
        if (!servedPath) {
            res.status(400).json({ success: false, error: 'path is required' });
            return;
        }
        const found = store.lookup(servedPath);
        const record = found ?? store.record(servedPath);
        res.json({ success: true, present: !!found, record: record ? { path: record.path, sha256: record.sha256, bytes: record.bytes, origin: record.origin, recipeId: record.recipeId, rebuilt: record.rebuilt, recordedAtMs: record.recordedAtMs } : null });
    });

    router.get('/events', (req: Request, res: Response) => {
        const subject = typeof req.query.subject === 'string' ? req.query.subject : undefined;
        const limit = Number(req.query.limit) || 100;
        res.json({ success: true, events: store.events({ ...(subject ? { subject } : {}), limit }) });
    });

    router.post('/recover', (req: Request, res: Response) => {
        const paths = Array.isArray(req.body?.paths) ? req.body.paths.filter((p: unknown): p is string => typeof p === 'string') : [];
        if (paths.length === 0) {
            res.status(400).json({ success: false, error: 'paths (a list of served paths) is required' });
            return;
        }
        if (paths.length > MAX_RECOVERY_PATHS) {
            res.status(400).json({ success: false, error: `at most ${MAX_RECOVERY_PATHS} paths per recovery` });
            return;
        }
        const fallback = req.body?.fallbackStagedRequest;
        let opts: { fallbackStaged?: { request: unknown }; activeArtifact?: { id: string; type: string; data?: unknown } } = {};
        if (fallback !== undefined) {
            if (!fallback || typeof fallback !== 'object' || typeof fallback.query !== 'string' || !fallback.query.trim()) {
                res.status(400).json({ success: false, error: 'fallbackStagedRequest needs a query (the place to rebuild)' });
                return;
            }
            opts = { fallbackStaged: { request: { ...fallback, query: fallback.query.trim(), isolate: fallback.isolate === true, trees: fallback.trees !== false } } };
        }
        const scene = req.body?.activeArtifact;
        if (scene !== undefined) {
            if (!scene || typeof scene !== 'object' || scene.type !== '3d-scene' || typeof scene.id !== 'string') {
                res.status(400).json({ success: false, error: 'activeArtifact must be the 3d-scene artifact the files belong to ({ id, type, data })' });
                return;
            }
            opts.activeArtifact = { id: scene.id, type: scene.type, data: scene.data };
        }
        res.json({ success: true, job: recovery.start(paths, opts) });
    });

    router.get('/recover/:id', (req: Request, res: Response) => {
        const job = recovery.get(req.params.id);
        if (!job) {
            res.status(404).json({ success: false, error: `no recovery job ${req.params.id}` });
            return;
        }
        res.json({ success: true, job });
    });

    router.post('/recover/:id/cancel', (req: Request, res: Response) => {
        const job = recovery.cancel(req.params.id);
        if (!job) {
            res.status(404).json({ success: false, error: `no recovery job ${req.params.id}` });
            return;
        }
        res.json({ success: true, job });
    });

    return router;
}
