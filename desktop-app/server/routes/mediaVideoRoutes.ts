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
    IMAGE_MODEL_PRIORITY,
    VIDEO_MODEL_PRIORITY,
    classifyMediaGenerationError,
    MediaGenerationRequest
} from '../../../packages/core/src/common';
import {
    GoogleMediaGenerationService,
    MediaGenerationJobService,
    MediaAssetStore,
    HeadlessVideoCompositorService
} from '../../../packages/core/src/node';
import { resolveWithinRoot } from '../../../packages/core/src/node/security/path-guard';
import { RouteContext } from './types';

export interface MediaRouterServices {
    mediaGenerator: GoogleMediaGenerationService;
    mediaJobs: MediaGenerationJobService;
    mediaAssets: MediaAssetStore;
}

export function createMediaRouter(services: MediaRouterServices, ctx: RouteContext): Router {
    const { mediaGenerator, mediaJobs, mediaAssets } = services;
    const { requireWorkspaceRoot, sendError, isPathError } = ctx;
    const router = Router();

    const startMediaJob = async (
        request: MediaGenerationRequest,
        res: Response,
        waitForCompletion: boolean
    ): Promise<void> => {
        try {
            const workspaceRoot = requireWorkspaceRoot(request?.workspaceRoot);
            const job = await mediaJobs.create({ ...request, workspaceRoot });
            if (waitForCompletion) {
                const completed = await mediaJobs.process(job.id, workspaceRoot);
                res.status(completed.status === 'completed' ? 200 : 422).json({
                    success: completed.status === 'completed',
                    job: completed,
                    error: completed.error
                });
                return;
            }
            mediaJobs.process(job.id, workspaceRoot).catch(() => undefined);
            res.status(202).json({ success: true, job });
        } catch (error) {
            if (isPathError(error)) {
                sendError(res, error);
                return;
            }
            const detail = (error as any)?.mediaError || classifyMediaGenerationError(error);
            const status = detail.code === 'unauthorized' ? 401
                : detail.code === 'quota' ? 429
                    : detail.code === 'invalid_request' ? 400
                        : detail.code === 'unsupported' ? 422 : 500;
            res.status(status).json({ success: false, error: detail });
        }
    };

    router.get('/capabilities', async (_req: Request, res: Response) => {
        try {
            const caps = await mediaGenerator.detectCapabilities();
            res.json({
                ...caps,
                image: {
                    supported: true,
                    models: IMAGE_MODEL_PRIORITY,
                    primaryModel: IMAGE_MODEL_PRIORITY[0]
                },
                video: {
                    supported: true,
                    models: VIDEO_MODEL_PRIORITY,
                    primaryModel: 'google/omni-1.1'
                },
                audio: {
                    supported: true,
                    models: ['gemini-2.5-flash-tts']
                }
            });
        } catch (err: any) {
            res.status(503).json({
                success: false,
                error: err?.message || 'Media capabilities unavailable'
            });
        }
    });

    router.post('/image/generate', async (req: Request, res: Response) => {
        await startMediaJob({ ...req.body, kind: 'image' }, res, true);
    });

    router.post('/video/generate', async (req: Request, res: Response) => {
        await startMediaJob({ ...req.body, kind: 'video' }, res, false);
    });

    router.post('/jobs', async (req: Request, res: Response) => {
        await startMediaJob(req.body as MediaGenerationRequest, res, false);
    });

    router.get('/jobs/:id', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = requireWorkspaceRoot(req.query.workspaceRoot);
            const job = await mediaJobs.get(req.params.id, workspaceRoot);
            if (!job) {
                res.status(404).json({
                    success: false,
                    error: { code: 'invalid_request', message: 'Media job not found', retryable: false }
                });
                return;
            }
            res.json({ success: true, job });
        } catch (error) {
            if (isPathError(error)) {
                sendError(res, error);
                return;
            }
            const detail = classifyMediaGenerationError(error);
            res.status(500).json({ success: false, error: detail });
        }
    });

    router.post('/jobs/:id/cancel', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = requireWorkspaceRoot(req.body?.workspaceRoot);
            const job = await mediaJobs.cancel(req.params.id, workspaceRoot);
            res.json({ success: true, job });
        } catch (error) {
            if (isPathError(error)) {
                sendError(res, error);
                return;
            }
            const detail = classifyMediaGenerationError(error);
            res.status(400).json({ success: false, error: detail });
        }
    });

    router.get('/jobs/:id/content', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = requireWorkspaceRoot(req.query.workspaceRoot);
            const job = await mediaJobs.get(req.params.id, workspaceRoot);
            if (!job?.result?.asset || job.status !== 'completed') {
                res.status(404).json({
                    success: false,
                    error: { code: 'invalid_request', message: 'Completed media asset not found', retryable: false }
                });
                return;
            }
            // Asset paths are derived from stored job data; keep them inside the workspace regardless.
            const filePath = resolveWithinRoot(workspaceRoot, mediaAssets.resolve(workspaceRoot, job.result.asset));
            res.type(job.result.asset.mimeType);
            res.setHeader('Cache-Control', 'private, immutable, max-age=31536000');
            res.sendFile(filePath);
        } catch (error) {
            if (isPathError(error)) {
                sendError(res, error);
                return;
            }
            const detail = classifyMediaGenerationError(error);
            res.status(400).json({ success: false, error: detail });
        }
    });

    return router;
}

export function createVideoRouter(videoCompositor: HeadlessVideoCompositorService, ctx: RouteContext): Router {
    const { requireWorkspaceRoot, sendError, isPathError } = ctx;
    const router = Router();

    router.get('/capabilities', async (_req: Request, res: Response) => {
        const available = await videoCompositor.isFfmpegAvailable();
        res.json({
            success: true,
            ffmpegAvailable: available,
            features: {
                chromaKeying: true,
                despillSuppression: true,
                spatialTransform2D: true,
                opticalLightWrap: true,
                lutColorGrading: true,
                audioMix: true
            },
            supportedFormats: ['mp4', 'mov', 'webm', 'gif']
        });
    });

    router.post('/filtergraph', (req: Request, res: Response) => {
        try {
            const { timeline, resolution, customInputs } = req.body || {};
            if (!timeline) {
                res.status(400).json({ success: false, error: 'Missing timeline data' });
                return;
            }
            const graph = videoCompositor.buildFilterGraph(timeline, resolution, customInputs);
            res.json({ success: true, graph });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || 'Filtergraph generation failed' });
        }
    });

    router.post('/composite', async (req: Request, res: Response) => {
        try {
            const { timeline, outputPath, workspaceRoot, resolution, format, crf, preset, dryRun, customInputs } = req.body || {};
            if (!timeline) {
                res.status(400).json({ success: false, error: 'Missing timeline data' });
                return;
            }
            if (!outputPath) {
                res.status(400).json({ success: false, error: 'Missing outputPath' });
                return;
            }

            if (typeof outputPath !== 'string') {
                res.status(400).json({ success: false, error: 'outputPath must be a string' });
                return;
            }
            if (customInputs !== undefined && (typeof customInputs !== 'object' || customInputs === null || Array.isArray(customInputs)
                || Object.values(customInputs).some(v => typeof v !== 'string'))) {
                res.status(400).json({ success: false, error: 'customInputs must map clip ids to path strings' });
                return;
            }

            // Always confine output and local inputs to an allowed workspace root
            // (requireWorkspaceRoot falls back to the server cwd, which must itself be allowlisted).
            const safeRoot = requireWorkspaceRoot(workspaceRoot);
            const resolvedOutputPath = resolveWithinRoot(safeRoot, outputPath);

            const result = await videoCompositor.execute({
                timeline,
                outputPath: resolvedOutputPath,
                workspaceRoot: safeRoot,
                inputRoot: safeRoot,
                resolution,
                format,
                crf,
                preset,
                dryRun,
                customInputs
            });

            res.json(result);
        } catch (err: any) {
            if (isPathError(err)) {
                sendError(res, err);
                return;
            }
            if (err?.code === 'invalid_media_input') {
                res.status(400).json({ success: false, error: err.message });
                return;
            }
            res.status(500).json({ success: false, error: err?.message || 'Video compositing failed' });
        }
    });

    return router;
}
