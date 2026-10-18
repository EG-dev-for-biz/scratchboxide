/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Request, Response, Router } from 'express';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { VirtualGeometryBuildError, VirtualGeometryBuildService } from '../../../packages/core/src/node';
import { resolveWithinRoot } from '../../../packages/core/src/node/security/path-guard';
import { RouteContext } from './types';

/**
 * POST /build  { sourceGlbPath, workspaceRoot? } | { glbBase64 }
 *   Builds (or reuses) the cluster LOD DAG for a GLB. Files are keyed by the GLB's content hash and the
 *   builder's hash, so the same model is built once per builder and a changed GLB gets a new URL. The
 *   viewport calls this every time it opens a scene with a source, so a stale saved URL is replaced.
 *   A client that disconnects stops the build.
 *   -> { success, sbvgUrl, cached, summary, stats?, buildMs? }
 */
export function createVirtualGeometryRouter(service: VirtualGeometryBuildService, ctx: RouteContext): Router {
    const router = Router();

    router.post('/build', async (req: Request, res: Response) => {
        const body = req.body || {};
        let tmpDir: string | undefined;
        const disconnected = new AbortController();
        res.on('close', () => { if (!res.writableFinished) disconnected.abort(); });
        try {
            let glbPath: string;
            if (typeof body.glbBase64 === 'string' && body.glbBase64.length > 0) {
                const buf = Buffer.from(body.glbBase64, 'base64');
                if (buf.length < 12 || buf.toString('utf8', 0, 4) !== 'glTF') {
                    res.status(400).json({ success: false, error: 'glbBase64 is not a binary glTF (.glb)' });
                    return;
                }
                tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sbx-vgeo-'));
                glbPath = path.join(tmpDir, 'input.glb');
                await fs.writeFile(glbPath, buf);
            } else if (typeof body.sourceGlbPath === 'string' && body.sourceGlbPath.trim()) {
                const root = ctx.requireWorkspaceRoot(body.workspaceRoot);
                glbPath = resolveWithinRoot(root, body.sourceGlbPath.trim());
                if (!(await fs.pathExists(glbPath))) {
                    res.status(404).json({ success: false, error: `GLB not found in the workspace (${root}): ${body.sourceGlbPath}` });
                    return;
                }
            } else {
                res.status(400).json({ success: false, error: 'Send sourceGlbPath (inside the workspace) or glbBase64' });
                return;
            }
            const { sbvgUrl, cached, summary, stats, buildMs } = await service.buildServed(glbPath, { signal: disconnected.signal });
            res.json({ success: true, sbvgUrl, cached, summary, stats, buildMs });
        } catch (err) {
            if ((err as Error)?.name === 'AbortError') return; // the client is gone
            if (err instanceof VirtualGeometryBuildError) {
                res.status(422).json({ success: false, error: err.message, output: err.output });
                return;
            }
            ctx.sendError(res, err);
        } finally {
            if (tmpDir) await fs.remove(tmpDir).catch(() => undefined);
        }
    });

    return router;
}
