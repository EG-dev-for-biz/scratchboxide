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
import * as path from 'path';
import { NativeCppCompilerService, NativePythonRunnerService } from '../../../packages/core/src/node';
import { RouteContext } from './types';

export function createCppRouter(cppCompiler: NativeCppCompilerService, ctx: RouteContext): Router {
    const { sendError } = ctx;
    const router = Router();

    router.post('/compile', async (req: Request, res: Response) => {
        try {
            const { sourceCode, optimization, args, assets, geoAnchor, tileGlbBase64, tileAssetId } = req.body || {};
            if (!sourceCode || typeof sourceCode !== 'string') {
                res.status(400).json({ error: 'Missing "sourceCode" parameter' });
                return;
            }

            const stagedAssets: Array<{ name: string; content: string; encoding?: 'utf8' | 'base64' }> = [];

            if (Array.isArray(assets)) {
                stagedAssets.push(...assets);
            }

            if (geoAnchor) {
                stagedAssets.push({
                    name: 'geo_anchor.json',
                    content: JSON.stringify(geoAnchor, null, 2),
                    encoding: 'utf8'
                });
            }

            if (tileGlbBase64) {
                stagedAssets.push({
                    name: 'tile_payload.glb',
                    content: tileGlbBase64,
                    encoding: 'base64'
                });
            } else if (tileAssetId) {
                const cacheFile = path.resolve(process.cwd(), '.scratchbox/tiles_cache', `${tileAssetId}.glb`);
                if (fs.existsSync(cacheFile)) {
                    stagedAssets.push({
                        name: 'tile_payload.glb',
                        content: fs.readFileSync(cacheFile).toString('base64'),
                        encoding: 'base64'
                    });
                }
            }

            const compileRes = await cppCompiler.compileSource(sourceCode, {
                optimization: optimization || '-O3',
                assets: stagedAssets
            });

            if (!compileRes.success || !compileRes.binaryPath) {
                res.json({
                    success: false,
                    compilerOutput: compileRes.compilerOutput,
                    diagnostics: compileRes.diagnostics,
                    compilationTimeMs: compileRes.compilationTimeMs
                });
                return;
            }

            const execRes = await cppCompiler.executeBinary(compileRes.binaryPath, args || []);

            res.json({
                success: execRes.success,
                compilerOutput: compileRes.compilerOutput,
                diagnostics: compileRes.diagnostics,
                compilationTimeMs: compileRes.compilationTimeMs,
                executionTimeMs: execRes.executionTimeMs,
                glbBase64: execRes.glbBase64,
                glbPath: execRes.glbPath,
                chunks: execRes.chunks,
                stdout: execRes.stdout,
                stderr: execRes.stderr
            });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    const handlePythonRun = async (req: Request, res: Response) => {
        try {
            const { script, timeoutMs } = req.body || {};
            if (!script || typeof script !== 'string') {
                res.status(400).json({ error: 'Missing "script" parameter' });
                return;
            }
            const runner = NativePythonRunnerService.getInstance();
            const result = await runner.runScript(script, { timeoutMs: timeoutMs || 30000 });
            res.json(result);
        } catch (err: any) {
            sendError(res, err);
        }
    };

    router.post('/python/run', handlePythonRun);
    router.post('/run-python', handlePythonRun);

    return router;
}
